import {
  assertHttpsUrl,
  fetchText,
  retryAfterMs,
  SourceHttpError,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";
import { collectPostingLinks } from "../posting-links";
import {
  extractJsonLdJobs,
  jsonLdExternalId,
  normalizeJsonLdJob,
  type JsonLdJob,
} from "./json-ld";

const maxPostingPages = 100;
const maxLinks = 200;

/**
 * A company careers page the resolver approved. Postings come from JSON-LD on
 * the listing page, or from JSON-LD on individual posting pages the listing
 * links to. No env allowlist: the per-company candidate row is the gate.
 */
export function createCareersConnector(
  options: ConnectorOptions = {},
): SourceConnector<JsonLdJob> {
  const cache = new Map<string, JsonLdJob>();
  const get = async (url: URL, signal?: AbortSignal) => {
    assertHttpsUrl(url);
    const { response, text } = await fetchText(url, {}, { ...options, signal });
    if (!response.ok)
      throw new SourceHttpError(
        response.status,
        retryAfterMs(response.headers.get("retry-after")),
      );
    return text;
  };
  return {
    name: "Careers",
    async search(query, _cursor, signal) {
      if (!query.sourceUrl) throw new Error("A careers page URL is required");
      const listingUrl = new URL(query.sourceUrl);
      const html = await get(listingUrl, signal);
      const inline = extractJsonLdJobs(html);
      const jobs = inline.map((job) => {
        const externalId = jsonLdExternalId(job);
        cache.set(externalId, job);
        return {
          externalId,
          url: job.url,
          sourceUrl: query.sourceUrl,
          company: query.company,
        };
      });
      const links = collectPostingLinks(html, listingUrl, maxLinks);
      const known = new Set(inline.map((job) => job.url));
      for (const link of links) {
        if (known.has(link.href)) continue;
        jobs.push({
          externalId: link.href,
          url: link.href,
          sourceUrl: query.sourceUrl,
          company: query.company,
        });
      }
      return {
        jobs: jobs.slice(0, maxLinks),
        complete: links.length < maxLinks,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      const cached = cache.get(reference.externalId);
      if (cached) return cached;
      if (cache.size >= maxPostingPages + maxLinks)
        throw new Error("Posting page cap reached for this scan");
      const html = await get(new URL(reference.url), signal);
      const job =
        extractJsonLdJobs(html).find(
          (candidate) =>
            candidate.url === reference.url ||
            jsonLdExternalId(candidate) === reference.externalId,
        ) ?? extractJsonLdJobs(html)[0];
      if (!job) throw new Error("Posting page has no JobPosting JSON-LD");
      const normalizedId = reference.externalId;
      cache.set(normalizedId, { ...job, url: job.url || reference.url });
      return { ...job, url: job.url || reference.url };
    },
    async normalize(raw, context) {
      return normalizeJsonLdJob(raw, context, "Careers");
    },
  };
}
