import {
  crawlMaxJobs,
  crawlMaxPages,
  jobInputSchema,
  type CrawledJob,
} from "@jobfinder/shared";
import { canonicalUrl } from "@jobfinder/shared/hash";
import {
  descriptionDigest,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

/**
 * Not chosen here. Both are derived from the crawler's session budget and
 * politeness gap in `packages/shared/src/crawler.ts`, which is the only
 * place that knows how many page loads one session can actually complete.
 * Asking for more than that used to guarantee the session ran out of budget
 * mid-crawl on any real board.
 */
const maxPages = crawlMaxPages;
const maxJobs = crawlMaxJobs;

export const crawledExternalId = (job: CrawledJob) =>
  job.id?.trim() || canonicalUrl(job.url);

/**
 * Last rung of the ladder. One crawler session returns every posting it could
 * read within a single browser session's wall-clock budget
 * (`crawlSessionBudgetMs`, `packages/shared/src/crawler.ts`) — `maxPages`
 * listing pages and `maxJobs` postings above, which is what that budget buys
 * at the session's politeness gap between page loads. Those two caps, and
 * the budget itself, are stated there rather than here so this comment
 * cannot go stale the way an earlier version of it did. A walk cut short by
 * those caps, by a spent budget, or by a listing page that would not load is
 * reported as `complete: false`, and `canMarkRemovals` is false regardless,
 * so removals are never marked from a partial view.
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
