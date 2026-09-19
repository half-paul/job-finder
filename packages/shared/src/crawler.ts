import { z } from "zod";

export const httpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((v) => new URL(v).protocol === "https:", "Use an HTTPS URL");

/** One posting as the crawler saw it. Untrusted until the worker validates it. */
export const crawledJobSchema = z.object({
  title: z.string().trim().min(1).max(300),
  url: httpsUrl,
  id: z.string().trim().max(200).optional(),
  location: z.string().trim().max(300).default(""),
  description: z.string().max(50_000).default(""),
  postedAt: z.string().max(64).nullable().default(null),
});
export type CrawledJob = z.infer<typeof crawledJobSchema>;

/**
 * ## The request's total time, and the one number the client shares
 *
 * The budget below governs a *session*, and a session only starts once the
 * per-host lock in `apps/crawler/src/session.ts` has been acquired. That is
 * not the same thing as the request's duration, and the difference was a
 * real bug: two companies on one host arrive together, the second waits out
 * the whole of the first crawl and only *then* starts its own full budget.
 * At the old numbers that is roughly 90 s of waiting plus 90 s of crawling
 * against a client that gives up at 120 s, so the worker aborted the second
 * crawl and got nothing — after holding a connection open for two minutes.
 *
 * So the bound is written here, from request arrival rather than from lock
 * acquisition, as an addition the compiler and the test suite can both see:
 *
 *     lock wait      15 s   how long a request will queue behind another
 *                           crawl of the same host before refusing
 *   + session budget 75 s   the wall clock `session.ts` hands `open()`
 *   + session overrun 10 s  work that still runs after the deadline: the
 *                           last page's `networkidle` settle (5 s), its
 *                           content read and the context teardown
 *   + transport       5 s   HTTP framing, JSON encode/decode of the
 *                           response, the Compose bridge hop
 *   ------------------------
 *   = worst case    105 s   against a 120 s client timeout, so 15 s of
 *                           margin that nothing is allowed to spend
 *
 * `crawlClientTimeoutMs` is exported and read by
 * `packages/job-sources/src/crawler-client.ts` rather than restated there,
 * because the two sides drifting apart is precisely what created the bug.
 * `tests/unit/crawler-crawl.test.ts` asserts the sum, so an edit to either
 * side fails the suite instead of shipping.
 *
 * The lock wait is deliberately short. It is not sized to let a queued
 * request actually get its turn — at a 75 s budget it usually will not —
 * because a fast, typed refusal is a better answer than a held connection:
 * the worker learns the host is busy, can retry later, and the user sees a
 * real reason instead of an abort with nothing attached.
 */

/**
 * The crawler client's request timeout. Every other number in this section
 * is chosen to fit inside it with margin to spare.
 */
export const crawlClientTimeoutMs = 120_000;
/**
 * How long a request will wait for another crawl of the same host to finish
 * before refusing with `kind: "timeout"`. Counted from request arrival, not
 * from any later point — see `withSession` in `apps/crawler/src/session.ts`.
 */
export const crawlLockWaitMs = 15_000;
/**
 * Work that can still run after the session deadline has passed, because the
 * deadline is checked when a page load *starts*: the final page's
 * `networkidle` settle (5 s), its `page.content()` read, the navigation
 * latch's outstanding DNS lookups, and closing the browser context.
 */
export const crawlSessionOverrunMs = 10_000;
/** HTTP framing, JSON encode/decode, and the hop across the Compose bridge. */
export const crawlTransportOverheadMs = 5_000;

/**
 * ## One browser session's budget, and the caps derived from it
 *
 * These numbers used to be chosen in two different places — the session
 * budget and politeness gap in `apps/crawler/src/session.ts`, the page and
 * job caps in `packages/job-sources/src/connectors/browser.ts` — and they
 * contradicted each other outright: a 60 s budget with a 2 s gap allows ~28
 * page loads, while the connector asked for 20 listing pages plus 500
 * postings, i.e. up to 520 loads. Every crawl of a real board therefore ran
 * the budget out, and the resulting fatal failure discarded the whole
 * harvest. They are defined together here, with the arithmetic written down,
 * so the two halves cannot disagree again; `session.ts` and `browser.ts`
 * both import from this one place rather than restating a number.
 *
 * The reconciliation moves both ways. The gap comes down from 2 s to 1 s and
 * the budget up from 60 s to 75 s, which leaves room inside the crawler
 * client's request timeout for the bounded same-host lock wait as well (see
 * the section above) so the client never aborts a session that would
 * otherwise have finished. The caps then come *down* a long way to whatever
 * that actually buys, because the alternative — a budget large enough for
 * 520 loads — is over half an hour of held browser context and host lock per
 * company, which no HTTP request in this system is willing to wait for.
 *
 * What that buys is roughly fourteen postings from a three-page walk. That
 * is a real limitation and it is stated rather than hidden: the browser rung
 * is the last resort for a small company with no ATS and no captured API,
 * where a careers page of a handful of roles across one to three pages is
 * the normal case. Anything larger should be reached by the captured-API rung,
 * which has no browser and no politeness gap and keeps its own 500-job cap.
 * A walk that stops at these caps reports `complete: false`, and the browser
 * connector already sets `canMarkRemovals: false` unconditionally, so a
 * truncated view can never retire a posting.
 */
export const crawlSessionBudgetMs = 75_000;
/** Minimum interval between the *starts* of two page loads on one host. */
export const crawlMinGapMs = 1_000;
/**
 * What one load costs beyond the gap: `domcontentloaded` plus the
 * `networkidle` settle a JS-rendered careers page needs. A median, not a
 * worst case — the caps are a target, and the graceful truncation in
 * `crawl.ts` is what handles a session that turns out slower than this.
 */
export const crawlLoadCostMs = 2_500;
/** Budget spent before the first load: browser launch, robots.txt, teardown. */
export const crawlSessionOverheadMs = 15_000;

/** Longest a `/crawl` or `/capture` request can take the crawler: 105 s. */
export const crawlWorstCaseRequestMs =
  crawlLockWaitMs +
  crawlSessionBudgetMs +
  crawlSessionOverrunMs +
  crawlTransportOverheadMs;
/**
 * What is left of the client's patience once the worst case is spent: 15 s.
 * Kept comfortably positive on purpose — sizing the budget to land exactly on
 * 120 s would make every ordinary bit of jitter a client-side abort.
 */
export const crawlTimeoutMarginMs =
  crawlClientTimeoutMs - crawlWorstCaseRequestMs;

/** Page loads one session can complete inside its budget: 17. */
export const crawlLoadsPerSession = Math.floor(
  (crawlSessionBudgetMs - crawlSessionOverheadMs) /
    (crawlMinGapMs + crawlLoadCostMs),
);

/** Listing pages to walk. Each one costs a load. */
export const crawlMaxPages = 3;
/** Postings to open. Each one costs a load; the listing walk gets the rest. */
export const crawlMaxJobs = crawlLoadsPerSession - crawlMaxPages;

export const crawlRequestSchema = z.object({
  url: httpsUrl,
  maxPages: z.number().int().min(1).max(crawlMaxPages).default(crawlMaxPages),
  maxJobs: z.number().int().min(1).max(crawlMaxJobs).default(crawlMaxJobs),
});
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;

export const crawlResponseSchema = z.object({
  jobs: z.array(crawledJobSchema).max(crawlMaxJobs),
  complete: z.boolean(),
  warnings: z.array(z.string().max(500)).max(50),
});
export type CrawlResponse = z.infer<typeof crawlResponseSchema>;

export const captureRequestSchema = z.object({ url: httpsUrl });

/** Request headers a saved pattern may replay. Cookies and auth never qualify. */
export const capturedHeaderAllowlist = [
  "accept",
  "content-type",
  "x-requested-with",
] as const;

export const capturedRequestSchema = z.object({
  url: httpsUrl,
  method: z.enum(["GET", "POST"]),
  headers: z.record(z.string(), z.string().max(500)),
  /** Raw request body text, or null for GET. */
  body: z.string().max(10_000).nullable(),
  /** JSON pointer to the postings array inside the response. */
  jobsPath: z.string().max(200),
  sample: z.array(z.record(z.string(), z.unknown())).min(1).max(3),
});
export type CapturedRequest = z.infer<typeof capturedRequestSchema>;

export const captureResponseSchema = z.object({
  patterns: z.array(capturedRequestSchema).max(10),
  warnings: z.array(z.string().max(500)).max(50),
});
export type CaptureResponse = z.infer<typeof captureResponseSchema>;

export const crawlerErrorKinds = [
  "blocked",
  "timeout",
  "navigation",
  "captcha",
  "internal",
] as const;
export const crawlerErrorSchema = z.object({
  error: z.string().max(1000),
  kind: z.enum(crawlerErrorKinds),
});
export type CrawlerError = z.infer<typeof crawlerErrorSchema>;

/** JSON pointers relative to one posting object. */
export const patternFieldMapSchema = z.object({
  title: z.string().max(200),
  url: z.string().max(200),
  id: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  description: z.string().max(200).optional(),
  postedAt: z.string().max(200).optional(),
});
export type PatternFieldMap = z.infer<typeof patternFieldMapSchema>;

/** A replayable request. `{page}` in the template or body is 1-based. */
export const crawlPatternSpecSchema = z.object({
  urlTemplate: z.string().url().max(2000),
  method: z.enum(["GET", "POST"]),
  headers: z.record(z.string(), z.string().max(500)),
  body: z.string().max(10_000).nullable(),
  jobsPath: z.string().max(200),
  fieldMap: patternFieldMapSchema,
});
export type CrawlPatternSpec = z.infer<typeof crawlPatternSpecSchema>;

/** Renders a template string by replacing `{page}` with the given number. */
export function renderTemplate(template: string, page: number): string {
  return template.replace(/\{page\}/g, String(page));
}

/** RFC 6901 lookup. Empty pointer returns the document. */
export function jsonPointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return undefined;
      current = current[index];
    } else if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
