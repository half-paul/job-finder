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
 * the budget up from 60 s to 90 s, which is still comfortably inside the
 * crawler client's 120 s request timeout (`crawler-client.ts`) so the client
 * never aborts a session that would otherwise have finished. The caps then
 * come *down* a long way to whatever that actually buys, because the
 * alternative — a budget large enough for 520 loads — is over half an hour
 * of held browser context and host lock per company, which no HTTP request
 * in this system is willing to wait for.
 *
 * What that buys is roughly twenty postings from a three-page walk. That is
 * a real limitation and it is stated rather than hidden: the browser rung is
 * the last resort for a small company with no ATS and no captured API, where
 * a careers page of a handful of roles across one to three pages is the
 * normal case. Anything larger should be reached by the captured-API rung,
 * which has no browser and no politeness gap and keeps its own 500-job cap.
 * A walk that stops at these caps reports `complete: false`, and the browser
 * connector already sets `canMarkRemovals: false` unconditionally, so a
 * truncated view can never retire a posting.
 */
export const crawlSessionBudgetMs = 90_000;
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

/** Page loads one session can complete inside its budget: 21. */
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
