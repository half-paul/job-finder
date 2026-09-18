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
      // Extraction and schema validation are inside this try along with the
      // fetch: `crawledJobSchema.parse` can throw on a single over-long
      // title or JSON-LD description (extract.ts truncates neither), and
      // that must skip this one posting with a warning, not abort the
      // whole crawl as a 500 for an otherwise-successful run.
      try {
        const html = await session.open(url);
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
      } catch (error) {
        // A CAPTCHA ends the whole crawl: the site has declined automated
        // access outright, and trying the next URL only invites another one.
        // A spent session budget ("timeout") is exactly as unrecoverable —
        // every remaining URL would fail the same way, so continuing would
        // burn hundreds of dead iterations at maxJobs and, worse, bury the
        // one warning that actually explains what happened once
        // `warnings.slice(0, 50)` truncates the pile of copies.
        if (
          error instanceof CrawlerFailure &&
          (error.kind === "captcha" || error.kind === "timeout")
        )
          throw error;
        warnings.push(
          `Skipped ${url.href}: ${error instanceof Error ? error.message : "failed"}`,
        );
        complete = false;
      }
    }
    return { jobs, complete, warnings: warnings.slice(0, 50) };
  });
}
