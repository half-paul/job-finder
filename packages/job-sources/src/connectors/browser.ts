import { jobInputSchema, type CrawledJob } from "@jobfinder/shared";
import { canonicalUrl } from "@jobfinder/shared/hash";
import {
  descriptionDigest,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const maxPages = 20;
const maxJobs = 500;

export const crawledExternalId = (job: CrawledJob) =>
  job.id?.trim() || canonicalUrl(job.url);

/**
 * Last rung of the ladder. One crawler session returns every posting it could
 * read; an incomplete walk (page or job cap) is reported so removals are never
 * marked from a partial view.
 */
export function createBrowserConnector(
  options: ConnectorOptions = {},
): SourceConnector<CrawledJob> {
  const cache = new Map<string, CrawledJob>();
  return {
    name: "Browser",
    async search(query, _cursor, signal) {
      if (!query.sourceUrl) throw new Error("A careers page URL is required");
      const client = options.crawlerClient;
      if (!client)
        throw new Error(
          "Browser crawling is not configured; start the crawler service",
        );
      const result = await client.crawl(
        { url: query.sourceUrl, maxPages, maxJobs },
        signal,
      );
      return {
        jobs: result.jobs.map((job) => {
          const externalId = crawledExternalId(job);
          cache.set(externalId, job);
          return {
            externalId,
            url: job.url,
            sourceUrl: query.sourceUrl,
            company: query.company,
          };
        }),
        complete: result.complete,
        // A crawled page never proves the full inventory: an empty result is
        // what a login wall or a stale selector returns, so removals stay off.
        canMarkRemovals: false,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const cached = cache.get(reference.externalId);
      if (!cached)
        throw new Error("Crawled posting is no longer available in this scan");
      return cached;
    },
    async normalize(raw, context) {
      const company = context.query.company || context.query.board;
      const description =
        raw.description.trim().length >= 20
          ? raw.description.trim()
          : `No description was captured for this posting. See the original listing at ${raw.url}`;
      const input = jobInputSchema.parse({
        title: raw.title,
        company,
        description,
        location: raw.location,
        country: "",
        industry: "",
        employmentType: "Unknown",
        seniority: "Unknown",
        workType: /remote/i.test(`${raw.title} ${raw.location}`)
          ? "Remote"
          : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.postedAt),
      });
      return {
        ...input,
        externalId: crawledExternalId(raw),
        provider: "Browser" as const,
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
