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

  // Set when the session budget runs out. Every remaining `open()` would
  // fail identically, so the posting loop below is skipped rather than run
  // once per URL just to collect the same refusal N times. Kept as the error
  // rather than a boolean because if the budget expired before a single
  // posting could be read there is no harvest to return, and re-throwing it
  // gives the caller a 422 that says why instead of a silent empty 200.
  let budgetFailure: CrawlerFailure | null = null;

  let listing: URL | null = origin;
  for (let page = 0; page < input.maxPages && listing; page++) {
    let html: string;
    try {
      html = await session.open(listing);
    } catch (error) {
      // One listing page that will not load — or a budget that ran out
      // partway through the walk — must not discard the posting links the
      // earlier pages already yielded. Keep them, say so, stop paginating.
      // A CAPTCHA is the exception: the site has declined automated access
      // outright, so there is nothing to salvage and nothing to retry.
      if (error instanceof CrawlerFailure && error.kind === "captcha")
        throw error;
      // Nothing collected yet means there is no harvest to preserve, and the
      // original failure is a far better answer for the caller than an empty
      // 200 would be.
      if (found.size === 0) throw error;
      if (error instanceof CrawlerFailure && error.fatal) budgetFailure = error;
      warnings.push(
        `Stopped paginating at ${redactUrl(listing.href)}: ${
          error instanceof Error ? error.message : "failed"
        }`,
      );
      complete = false;
      break;
    }
    const links = postingLinks(html, listing);
    const next = nextPageLink(html, listing);
    // Both scans walk the same document, so a page big enough to hit a cap
    // hits it in both; the Set keeps that from spending two of the fifty
    // warning slots on the same sentence. A cap that truncated is a partial
    // view of this listing page, so it sets `complete: false` for exactly
    // the same reason the page and job caps below do.
    for (const note of new Set([...links.truncated, ...next.truncated])) {
      warnings.push(
        `Only part of the listing at ${redactUrl(listing.href)} was read: ${note}`,
      );
      complete = false;
    }
    for (const link of links.value) {
      if (found.size >= input.maxJobs) {
        complete = false;
        break;
      }
      found.set(link.href, link);
    }
    if (found.size >= input.maxJobs) break;
    if (next.value && page + 1 >= input.maxPages) complete = false;
    listing = next.value;
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
    if (budgetFailure) break;
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
      const extracted = extractPosting(html, url);
      for (const note of extracted.truncated) {
        warnings.push(
          `Only part of the posting at ${redactUrl(url.href)} was read: ${note}`,
        );
        complete = false;
      }
      const posting = extracted.value;
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
      // A CAPTCHA ends the whole crawl *and* discards it: the site has
      // declined automated access outright, trying the next URL only invites
      // another one, and what we hold may well be challenge pages rather
      // than postings. That is a refusal, so it is the one case that throws.
      if (error instanceof CrawlerFailure && error.kind === "captcha")
        throw error;
      // `fatal` is the other whole-crawl case — a spent session budget — and
      // it is NOT a refusal, it is a truncation. Every remaining URL would
      // fail the same way, so stop; but the postings already read are good
      // ones and are returned with `complete: false`, which is precisely the
      // contract the rest of the stack was built around (`canMarkRemovals`
      // downstream follows `complete`, so a partial view never retires a
      // job). Throwing here instead was what made a normal, budget-limited
      // crawl of a real board return a 422 with nothing in it.
      //
      // Note `fatal` is checked separately from `kind`: a spent budget is
      // `kind: "timeout"`, and so is one slow page's own `goto` timeout —
      // those two are not the same thing, and only the former sets `fatal`.
      if (error instanceof CrawlerFailure && error.fatal) {
        budgetFailure = error;
        warnings.push(
          `${error.message}; returning the ${jobs.length} of ${found.size} postings read so far`,
        );
        complete = false;
        break;
      }
      // `error.message` can be arbitrarily long (a library's own error text)
      // just as easily as `url.href` can — both go through the same bounded
      // collector, not just the URL half.
      warnings.push(
        `Skipped ${redactUrl(url.href)}: ${error instanceof Error ? error.message : "failed"}`,
      );
      complete = false;
    }
  }
  // A truncation that salvaged nothing is not a truncation, it is a failure:
  // an empty 200 would tell the worker "this careers page has no jobs", which
  // is a different and wrong statement. Only re-thrown when the harvest is
  // actually empty.
  if (jobs.length === 0 && budgetFailure) throw budgetFailure;
  return { jobs, complete, warnings: warnings.list() };
}

export async function runCrawl(input: CrawlRequest): Promise<CrawlResponse> {
  // Captured first, before anything can await: the bound the client is
  // promised covers queueing behind another crawl of this host as well as
  // the crawl itself, so it has to start when the request arrives rather
  // than when `withSession` finally wins the lock.
  const arrivedAt = Date.now();
  const origin = new URL(input.url);
  return withSession(
    origin,
    (session) => crawlFromSession(session, origin, input),
    { arrivedAt },
  );
}
