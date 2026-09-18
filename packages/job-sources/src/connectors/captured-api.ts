import {
  jobInputSchema,
  jsonPointerGet,
  renderTemplate,
  type CrawlPatternSpec,
  type PatternFieldMap,
} from "@jobfinder/shared";
import { canonicalUrl } from "@jobfinder/shared/hash";
import {
  descriptionDigest,
  fetchJson,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const maxPages = 20;
// Exported so tests can build an exact-boundary fixture from the real
// constant instead of hardcoding a postings count that could silently drift.
export const maxJobs = 500;

const readString = (
  raw: Record<string, unknown>,
  pointer: string | undefined,
): string => {
  if (!pointer) return "";
  const value = jsonPointerGet(raw, pointer);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
};

/** Absolute posting URL, resolved against the pattern's own origin. */
export const capturedUrl = (
  raw: Record<string, unknown>,
  fieldMap: PatternFieldMap,
  base: string,
): string | null => {
  const value = readString(raw, fieldMap.url);
  if (!value) return null;
  try {
    const resolved = new URL(value, base);
    return resolved.protocol === "https:" ? resolved.href : null;
  } catch {
    return null;
  }
};

export const capturedExternalId = (
  raw: Record<string, unknown>,
  fieldMap: PatternFieldMap,
  base: string,
): string =>
  readString(raw, fieldMap.id) ||
  canonicalUrl(capturedUrl(raw, fieldMap, base) ?? base);

/**
 * Fourth rung of the ladder: a JSON request a careers page was seen making,
 * replayed without a browser. Cheaper than a crawl and more reliable than DOM
 * scraping, because the site's own API is the source.
 */
export function createCapturedApiConnector(
  options: ConnectorOptions = {},
): SourceConnector<Record<string, unknown>> {
  const cache = new Map<string, Record<string, unknown>>();
  return {
    name: "CapturedApi",
    async search(query, _cursor, signal) {
      const spec: CrawlPatternSpec | null | undefined = options.crawlPattern;
      if (!spec)
        throw new Error("This source has no saved API pattern to replay");
      cache.clear();
      const transport = { ...options, signal: signal ?? options.signal };
      const jobs: {
        externalId: string;
        url: string;
        sourceUrl: string;
        company?: string;
      }[] = [];
      let complete = true;
      let parsedAny = false;
      let page = 1;
      // fetchJson throws SourceHttpError on any non-2xx/304 response instead of
      // returning a status, so a failed page is a real error here, not a signal
      // to stop early — the walk only ends on an empty page or a hit cap.
      for (; page <= maxPages && jobs.length < maxJobs; page++) {
        const url = new URL(renderTemplate(spec.urlTemplate, page));
        const { data } = await fetchJson(
          url,
          {
            ...transport,
            method: spec.method,
            body: spec.body ? renderTemplate(spec.body, page) : undefined,
          },
          spec.headers,
        );
        const postings = jsonPointerGet(data, spec.jobsPath);
        if (!Array.isArray(postings) || postings.length === 0) break;
        for (const entry of postings) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            continue;
          const raw = entry as Record<string, unknown>;
          const href = capturedUrl(raw, spec.fieldMap, spec.urlTemplate);
          const title = readString(raw, spec.fieldMap.title);
          if (!href || !title) continue;
          parsedAny = true;
          if (jobs.length >= maxJobs) {
            complete = false;
            break;
          }
          const externalId = capturedExternalId(
            raw,
            spec.fieldMap,
            spec.urlTemplate,
          );
          cache.set(externalId, raw);
          jobs.push({
            externalId,
            url: href,
            sourceUrl: spec.urlTemplate,
            company: query.company,
          });
        }
        // A pattern with no `{page}` placeholder returns the same body forever.
        if (
          !spec.urlTemplate.includes("{page}") &&
          !spec.body?.includes("{page}")
        )
          break;
      }
      if (page > maxPages) complete = false;
      // Reaching the job cap can never prove a complete inventory, so removals must
      // stay off — `canMarkRemovals` follows `complete`, and a truncated view that
      // claims completeness makes the caller delete postings it simply never read.
      if (jobs.length >= maxJobs) complete = false;
      if (!parsedAny)
        throw new Error("Saved API replay returned no parseable posting");
      return { jobs, complete, canMarkRemovals: complete, notModified: false };
    },
    async fetchJob(reference) {
      const cached = cache.get(reference.externalId);
      if (!cached)
        throw new Error(
          "Saved API posting is no longer available in this scan",
        );
      return cached;
    },
    async normalize(raw, context) {
      const spec = options.crawlPattern;
      if (!spec)
        throw new Error("This source has no saved API pattern to replay");
      const company = context.query.company || context.query.board;
      const jobUrl = capturedUrl(raw, spec.fieldMap, spec.urlTemplate);
      if (!jobUrl) throw new Error("Saved API posting has no usable URL");
      const captured = readString(raw, spec.fieldMap.description);
      const description =
        captured.length >= 20
          ? captured
          : `No description was captured for this posting. See the original listing at ${jobUrl}`;
      const location = readString(raw, spec.fieldMap.location);
      const input = jobInputSchema.parse({
        title: readString(raw, spec.fieldMap.title),
        company,
        description,
        location,
        country: "",
        industry: "",
        employmentType: "Unknown",
        seniority: "Unknown",
        workType: /remote/i.test(
          `${readString(raw, spec.fieldMap.title)} ${location}`,
        )
          ? "Remote"
          : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl,
        postedAt: isoDate(readString(raw, spec.fieldMap.postedAt) || null),
      });
      return {
        ...input,
        externalId: capturedExternalId(raw, spec.fieldMap, spec.urlTemplate),
        provider: "CapturedApi" as const,
        sourceUrl: jobUrl,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
