import {
  crawledJobSchema,
  type CrawledJob,
  type CrawlRequest,
  type CrawlResponse,
} from "@jobfinder/shared";
import { extractPosting, nextPageLink, postingLinks } from "./extract";
import { withSession, type Session } from "./session";
import { CrawlerFailure } from "./failure";
import { createWarningCollector, redactUrl } from "./warnings";

/**
 * The real crawl logic, separated from `withSession`'s browser/lock plumbing
 * the same way `captureFromSession` is in `capture.ts`: this is what a test
 * drives directly, against a `Session` it controls, with no browser.
 */
export async function crawlFromSession(
  session: Session,
  origin: URL,
  input: CrawlRequest,
): Promise<CrawlResponse> {
  const warnings = createWarningCollector();
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
    // fetch: `crawledJobSchema.parse` can throw on a single over-long title
    // or JSON-LD description (extract.ts truncates neither), and that must
    // skip this one posting with a warning, not abort the whole crawl as a
    // 500 for an otherwise-successful run.
    try {
      const html = await session.open(url);
      const posting = extractPosting(html, url);
      if (!posting) {
        warnings.push(`No readable posting at ${redactUrl(url.href)}`);
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
      // `fatal` covers the other whole-crawl case: a spent session budget,
      // which is `kind: "timeout"` but so is a single slow page's own
      // `goto` timeout — those two are NOT the same thing. Matching on
      // `kind === "timeout"` alone would abort the crawl over one slow page
      // that should just be skipped, so the budget case is the one that
      // sets `fatal: true`; a per-page timeout does not.
      if (
        error instanceof CrawlerFailure &&
        (error.kind === "captcha" || error.fatal)
      )
        throw error;
      // `error.message` can be arbitrarily long (a library's own error text)
      // just as easily as `url.href` can — both go through the same bounded
      // collector, not just the URL half.
      warnings.push(
        `Skipped ${redactUrl(url.href)}: ${error instanceof Error ? error.message : "failed"}`,
      );
      complete = false;
    }
  }
  return { jobs, complete, warnings: warnings.list() };
}

export async function runCrawl(input: CrawlRequest): Promise<CrawlResponse> {
  const origin = new URL(input.url);
  return withSession(origin, (session) =>
    crawlFromSession(session, origin, input),
  );
}
