import {
  crawledJobSchema,
  type CrawledJob,
  type CrawlRequest,
  type CrawlResponse,
} from "@jobfinder/shared";
import { extractPosting, nextPageLink, postingLinks } from "./extract";
import { withSession } from "./session";
import { CrawlerFailure } from "./failure";

export async function runCrawl(input: CrawlRequest): Promise<CrawlResponse> {
  const origin = new URL(input.url);
  return withSession(origin, async (session) => {
    const warnings: string[] = [];
    const found = new Map<string, URL>();
    let complete = true;

    let listing: URL | null = origin;
    for (let page = 0; page < input.maxPages && listing; page++) {
      const html = await session.open(listing);
      for (const link of postingLinks(html, listing)) {
        if (found.size >= input.maxJobs) {
          complete = false;
          break;
        }
        found.set(link.href, link);
      }
      if (found.size >= input.maxJobs) break;
      const next: URL | null = nextPageLink(html, listing);
      if (next && page + 1 >= input.maxPages) complete = false;
      listing = next;
    }

    if (found.size === 0)
      throw new CrawlerFailure(
        "No job postings were found on the careers page",
        "navigation",
      );

    // Annotated explicitly: under strict mode, `const jobs = []` infers
    // `never[]`, which then rejects every `jobs.push(...)` below.
    const jobs: CrawledJob[] = [];
    for (const url of found.values()) {
      if (jobs.length >= input.maxJobs) {
        complete = false;
        break;
      }
      let html: string;
      try {
        html = await session.open(url);
      } catch (error) {
        if (error instanceof CrawlerFailure && error.kind === "captcha")
          throw error;
        warnings.push(
          `Skipped ${url.href}: ${error instanceof Error ? error.message : "failed"}`,
        );
        complete = false;
        continue;
      }
      const posting = extractPosting(html, url);
      if (!posting) {
        warnings.push(`No readable posting at ${url.href}`);
        complete = false;
        continue;
      }
      jobs.push(
        crawledJobSchema.parse({
          title: posting.title,
          url: url.href,
          location: posting.location,
          description: posting.description,
          postedAt: posting.postedAt,
        }),
      );
    }
    return { jobs, complete, warnings: warnings.slice(0, 50) };
  });
}
