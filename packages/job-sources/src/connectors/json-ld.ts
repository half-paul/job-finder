import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  assertHttpsUrl,
  descriptionDigest,
  fetchText,
  htmlToText,
  isoDate,
  retryAfterMs,
  SourceHttpError,
  type ConnectorOptions,
  type NormalizeContext,
  type NormalizedJob,
  type SourceConnector,
  type SourceProvider,
} from "../index";

const addressSchema = z.object({
  addressLocality: z.string().optional(),
  addressRegion: z.string().optional(),
  addressCountry: z
    .union([z.string(), z.object({ name: z.string().optional() })])
    .optional(),
});

export const jsonLdJobSchema = z.object({
  "@type": z.literal("JobPosting"),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  identifier: z
    .union([
      z.string(),
      z.number(),
      z.object({ value: z.union([z.string(), z.number()]).optional() }),
    ])
    .nullable()
    .optional(),
  datePosted: z.string().optional().nullable(),
  validThrough: z.string().optional().nullable(),
  employmentType: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default(""),
  jobLocationType: z.string().optional().nullable(),
  hiringOrganization: z.object({ name: z.string().optional() }).optional(),
  jobLocation: z
    .union([
      z.object({ address: addressSchema.optional() }),
      z.array(z.object({ address: addressSchema.optional() })),
    ])
    .nullable()
    .optional(),
  applicantLocationRequirements: z
    .union([
      z.object({ name: z.string().optional() }),
      z.array(z.object({ name: z.string().optional() })),
    ])
    .nullable()
    .optional(),
  baseSalary: z
    .object({
      currency: z.string().optional(),
      value: z
        .object({
          value: z.union([z.number(), z.string()]).optional(),
          minValue: z.union([z.number(), z.string()]).optional(),
          maxValue: z.union([z.number(), z.string()]).optional(),
          unitText: z.string().optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});
export type JsonLdJob = z.infer<typeof jsonLdJobSchema>;

/** Longer than any real `<script ...>` open tag. */
const maxScriptTagLength = 4096;
/** A page with more JSON-LD blocks than this is not a careers page. */
const maxLdJsonBlocks = 1000;

/**
 * The body of each `<script type="application/ld+json">` block, in document
 * order.
 *
 * This used to be one regex — `/<script\b[^>]*type=...[^>]*>([\s\S]*?)<\/script>/gi`
 * — matched against the whole page. That is quadratic on untrusted input: on
 * a document of `"<script"` repeated with no closing tag, `[^>]*` runs to the
 * end of the page from every one of the ~n/7 opening positions. `extractPosting`
 * in `apps/crawler/src/extract.ts` calls this first, on an unvetted careers
 * page that may be up to the 8 MB page cap, in a single-threaded process that
 * also answers `/health` — so this was an outright denial of service for one
 * hostile page. See the sibling note on `stripElement` in `../index.ts`.
 *
 * Both cursors only move right, so the whole scan is linear in page length.
 */
function* ldJsonBlocks(html: string): Generator<string> {
  const lower = html.toLowerCase();
  let pos = 0;
  let blocks = 0;
  while (blocks < maxLdJsonBlocks) {
    const start = lower.indexOf("<script", pos);
    if (start < 0) return;
    const nameEnd = start + "<script".length;
    const after = lower.charCodeAt(nameEnd);
    // The `\b` the old pattern had: `<scriptable>` is not a `<script>`.
    if ((after >= 97 && after <= 122) || (after >= 48 && after <= 57)) {
      pos = nameEnd;
      continue;
    }
    const tagEnd = lower.indexOf(">", nameEnd);
    // No `>` left anywhere means no later `<script` can be complete either.
    if (tagEnd < 0) return;
    pos = tagEnd + 1;
    if (tagEnd - start > maxScriptTagLength) continue;
    if (
      !/type=["']application\/ld\+json["']/.test(lower.slice(start, tagEnd + 1))
    )
      continue;
    const close = lower.indexOf("</script", pos);
    if (close < 0) return;
    blocks++;
    yield html.slice(pos, close);
    pos = close + "</script".length;
  }
}

export function extractJsonLdJobs(html: string): JsonLdJob[] {
  const jobs: JsonLdJob[] = [];
  for (const block of ldJsonBlocks(html)) {
    try {
      const parsed: unknown = JSON.parse(block);
      const nodes = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            "@graph" in parsed &&
            Array.isArray((parsed as { "@graph": unknown[] })["@graph"])
          ? (parsed as { "@graph": unknown[] })["@graph"]
          : [parsed];
      for (const node of nodes) {
        const job = jsonLdJobSchema.safeParse(node);
        if (job.success) jobs.push(job.data);
      }
    } catch {
      // A page can contain an invalid JSON-LD block alongside a valid one.
    }
  }
  return jobs;
}

export function jsonLdExternalId(job: JsonLdJob): string {
  const id = job.identifier;
  const value =
    typeof id === "string" || typeof id === "number"
      ? String(id)
      : id && typeof id === "object" && id.value !== undefined
        ? String(id.value)
        : "";
  // A blank identifier is not an identity: without this fallback every posting
  // that carries one would share a single external id and overwrite the others.
  return value.trim() || job.url;
}

const toInt = (value: number | string | undefined) => {
  if (value === undefined) return null;
  // "Competitive", "DOE" and "" all strip to an empty string, and Number("")
  // is 0. A salary the posting never stated must stay unknown, because a
  // fabricated 0 reaches both the salary display and the AI evaluator.
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const parsed = Math.round(Number(cleaned));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const currencyOf = (
  value: string | undefined,
): "CAD" | "USD" | "EUR" | "GBP" | "Unknown" => {
  const upper = (value ?? "").toUpperCase();
  return upper === "CAD" ||
    upper === "USD" ||
    upper === "EUR" ||
    upper === "GBP"
    ? upper
    : "Unknown";
};

const periodOf = (unit: string | undefined) => {
  const upper = (unit ?? "").toUpperCase();
  if (upper === "YEAR") return "year" as const;
  if (upper === "MONTH") return "month" as const;
  if (upper === "WEEK") return "week" as const;
  if (upper === "DAY") return "day" as const;
  if (upper === "HOUR") return "hour" as const;
  return "unknown" as const;
};

/** Shared by the allowlisted JSON-LD connector and the per-company Careers connector. */
export function normalizeJsonLdJob(
  raw: JsonLdJob,
  context: NormalizeContext,
  provider: SourceProvider,
): NormalizedJob {
  const description = htmlToText(raw.description);
  const locations = Array.isArray(raw.jobLocation)
    ? raw.jobLocation
    : raw.jobLocation
      ? [raw.jobLocation]
      : [];
  const address = locations[0]?.address;
  const country =
    typeof address?.addressCountry === "string"
      ? address.addressCountry
      : (address?.addressCountry?.name ?? "");
  const requirements = Array.isArray(raw.applicantLocationRequirements)
    ? raw.applicantLocationRequirements
    : raw.applicantLocationRequirements
      ? [raw.applicantLocationRequirements]
      : [];
  const applicantCountries = requirements
    .map((r) => r.name)
    .filter((n): n is string => Boolean(n));
  const location = [
    [address?.addressLocality, address?.addressRegion]
      .filter(Boolean)
      .join(", "),
    applicantCountries.length
      ? `Applicants: ${applicantCountries.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const employment = Array.isArray(raw.employmentType)
    ? raw.employmentType.join(" ")
    : raw.employmentType;
  const remote =
    /TELECOMMUTE/i.test(raw.jobLocationType ?? "") ||
    /remote/i.test(`${raw.title} ${description}`);
  const salary = raw.baseSalary?.value;
  const single = toInt(salary?.value);
  const input = jobInputSchema.parse({
    title: raw.title,
    company:
      raw.hiringOrganization?.name ||
      context.query.company ||
      context.query.board,
    description,
    location,
    country,
    industry: "",
    employmentType: /contract/i.test(employment)
      ? "Contract"
      : /part|temp/i.test(employment)
        ? "Temporary"
        : /full/i.test(employment)
          ? "Full-time"
          : "Unknown",
    seniority: "Unknown",
    workType: remote ? "Remote" : "Unknown",
    salaryMin: toInt(salary?.minValue) ?? single,
    salaryMax: toInt(salary?.maxValue) ?? single,
    salaryPeriod: periodOf(salary?.unitText),
    currency: currencyOf(raw.baseSalary?.currency),
    jobUrl: raw.url,
    postedAt: isoDate(raw.datePosted),
  });
  return {
    ...input,
    externalId: jsonLdExternalId(raw),
    provider,
    sourceUrl: raw.url,
    descriptionHash: descriptionDigest(description),
  };
}

export function createJsonLdConnector(
  options: ConnectorOptions = {},
): SourceConnector<JsonLdJob> {
  const cache = new Map<string, JsonLdJob>();
  return {
    name: "JSON-LD",
    async search(query, cursor, signal) {
      if (!query.sourceUrl) throw new Error("A JSON-LD source URL is required");
      const url = new URL(query.sourceUrl);
      const allowed = (options.jsonLdAllowedHosts ?? []).map((host) =>
        host.toLowerCase().replace(/^\*\./, ""),
      );
      if (
        !allowed.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      )
        throw new Error("JSON-LD host is not allowlisted");
      assertHttpsUrl(url);
      const headers: Record<string, string> = {};
      if (cursor?.etag) headers["If-None-Match"] = cursor.etag;
      if (cursor?.lastModified)
        headers["If-Modified-Since"] = cursor.lastModified;
      const { response, text } = await fetchText(url, headers, {
        ...options,
        signal,
      });
      if (response.status === 304)
        return { jobs: [], complete: true, notModified: true };
      if (!response.ok)
        throw new SourceHttpError(
          response.status,
          retryAfterMs(response.headers.get("retry-after")),
        );
      const jobs = extractJsonLdJobs(text);
      return {
        jobs: jobs.map((job) => {
          const externalId = jsonLdExternalId(job);
          cache.set(externalId, job);
          return {
            externalId,
            url: job.url,
            sourceUrl: query.sourceUrl,
            company: query.company,
          };
        }),
        next:
          response.headers.get("etag") || response.headers.get("last-modified")
            ? {
                etag: response.headers.get("etag") ?? undefined,
                lastModified:
                  response.headers.get("last-modified") ?? undefined,
              }
            : undefined,
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      if (!reference.sourceUrl)
        throw new Error("A JSON-LD source URL is required");
      const cached = cache.get(reference.externalId);
      if (cached) return cached;
      const url = new URL(reference.sourceUrl);
      assertHttpsUrl(url);
      const { response, text } = await fetchText(
        url,
        {},
        { ...options, signal },
      );
      if (!response.ok)
        throw new SourceHttpError(
          response.status,
          retryAfterMs(response.headers.get("retry-after")),
        );
      const job = extractJsonLdJobs(text).find(
        (candidate) =>
          jsonLdExternalId(candidate) === reference.externalId ||
          candidate.url === reference.externalId,
      );
      if (!job) throw new Error("JSON-LD job is no longer present");
      return job;
    },
    async normalize(raw, context) {
      return normalizeJsonLdJob(raw, context, "JSON-LD");
    },
  };
}
