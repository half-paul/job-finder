import { describe, expect, it } from "vitest";
import {
  crawlLoadCostMs,
  crawlLoadsPerSession,
  crawlMaxJobs,
  crawlMaxPages,
  crawlMinGapMs,
  crawlRequestSchema,
  crawlResponseSchema,
  crawlSessionBudgetMs,
  crawlSessionOverheadMs,
  type CrawlRequest,
} from "@jobfinder/shared";
import { crawlFromSession } from "../../apps/crawler/src/crawl";
import { CrawlerFailure } from "../../apps/crawler/src/failure";
import type { Session } from "../../apps/crawler/src/session";

/**
 * Drives `crawlFromSession` against a `Session` this test controls entirely
 * — the same separation `captureFromSession` gets from `withSession`. This
 * is what makes it possible to prove the warning bound holds for `runCrawl`
 * too, without a browser: map each URL `crawlFromSession` will `open()` to
 * either HTML or a failure to throw.
 */
function fakeSession(pages: Record<string, string | Error>): Session {
  return {
    async open(url) {
      const outcome = pages[url.href];
      if (outcome === undefined)
        throw new Error(`Unexpected open(${url.href})`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    onJsonResponse() {},
    onJsonSkip() {},
    async settle() {},
  };
}

const input: CrawlRequest = { url: "", maxPages: 1, maxJobs: crawlMaxJobs };
const postingHtml = (title: string) =>
  `<html><body><h1>${title}</h1><div class="description">A real role.</div></body></html>`;

describe("crawl warnings", () => {
  it("keeps a long-URL skip warning inside a parseable CrawlResponse", async () => {
    const origin = new URL("https://acme.example/careers");
    // A path long enough that "Skipped <url>: <message>" alone would exceed
    // crawlResponseSchema's 500-char per-warning cap if it were not bounded
    // — the same failure that would otherwise ship a 200 the client's own
    // crawlResponseSchema.parse then rejects, discarding every job the
    // crawl found for the sake of this one skipped posting's warning text.
    const longSlug = "a".repeat(2000);
    const longUrl = new URL(
      `https://acme.example/careers/job/${longSlug}-1234`,
    );
    const shortUrl = new URL(
      "https://acme.example/careers/job/staff-engineer-5678",
    );
    const listingHtml = `<html><body>
      <a href="${longUrl.pathname}">Long slug job</a>
      <a href="${shortUrl.pathname}">Staff Engineer</a>
    </body></html>`;

    const session = fakeSession({
      [origin.href]: listingHtml,
      [longUrl.href]: new CrawlerFailure(
        "boom: navigation failed",
        "navigation",
      ),
      [shortUrl.href]: postingHtml("Staff Engineer"),
    });

    const result = await crawlFromSession(session, origin, input);

    // The real assertion: the client's own schema (crawlResponseSchema,
    // imported here rather than re-typed) must accept this response.
    expect(() => crawlResponseSchema.parse(result)).not.toThrow();
    expect(result.jobs).toHaveLength(1);
    const skipWarning = result.warnings.find((w) => w.startsWith("Skipped"));
    expect(skipWarning).toBeDefined();
    expect(skipWarning!.length).toBeLessThanOrEqual(500);
    // Redacted the same way capture.ts's warnings are: the 2000-char slug
    // must not survive into the warning verbatim.
    expect(skipWarning).not.toContain("a".repeat(2000));
  });
});

describe("crawl truncation", () => {
  const origin = new URL("https://acme.example/careers");
  const jobUrl = (n: number) =>
    new URL(`https://acme.example/careers/job/role-${n}000`);
  const listing = (links: URL[], next?: string) =>
    `<html><body>
      ${links.map((u) => `<a href="${u.pathname}">Role</a>`).join("\n")}
      ${next ? `<a rel="next" href="${next}">Next</a>` : ""}
    </body></html>`;

  /** What `session.ts` throws once the wall-clock budget is gone. */
  const budgetExpired = () =>
    new CrawlerFailure(
      "Crawl session budget of 90s exhausted",
      "timeout",
      true,
    );

  it("returns the postings already read when the session budget expires", async () => {
    // The defect this pins: a crawl that simply runs out of its 60/90-second
    // budget is the NORMAL end of a real board walk, not an edge case. It
    // used to re-throw, so the worker got a 422 and every posting already
    // extracted was discarded — making the `complete: false` truncation
    // contract that the whole stack is built around unreachable in practice.
    const pages: Record<string, string | Error> = {
      [origin.href]: listing([jobUrl(1), jobUrl(2), jobUrl(3)]),
      [jobUrl(1).href]: postingHtml("Role One"),
      [jobUrl(2).href]: postingHtml("Role Two"),
      [jobUrl(3).href]: budgetExpired(),
    };
    const result = await crawlFromSession(fakeSession(pages), origin, input);

    expect(result.jobs.map((j) => j.title)).toEqual(["Role One", "Role Two"]);
    expect(result.complete).toBe(false);
    expect(result.warnings.some((w) => /budget of 90s/.test(w))).toBe(true);
    expect(() => crawlResponseSchema.parse(result)).not.toThrow();
  });

  it("still aborts outright on a CAPTCHA, which is a refusal not a truncation", async () => {
    const pages: Record<string, string | Error> = {
      [origin.href]: listing([jobUrl(1), jobUrl(2)]),
      [jobUrl(1).href]: postingHtml("Role One"),
      [jobUrl(2).href]: new CrawlerFailure("challenge page", "captcha"),
    };
    await expect(
      crawlFromSession(fakeSession(pages), origin, input),
    ).rejects.toMatchObject({ kind: "captcha" });
  });

  it("re-throws a budget expiry that salvaged nothing rather than returning an empty 200", async () => {
    // An empty 200 would tell the worker "this careers page has no jobs",
    // which is a different and wrong statement.
    const pages: Record<string, string | Error> = {
      [origin.href]: listing([jobUrl(1)]),
      [jobUrl(1).href]: budgetExpired(),
    };
    await expect(
      crawlFromSession(fakeSession(pages), origin, input),
    ).rejects.toMatchObject({ kind: "timeout", fatal: true });
  });

  it("keeps links from earlier listing pages when a later one fails", async () => {
    // F5: the pagination loop had no `try`, so one unreadable listing page
    // discarded every link the pages before it had already yielded.
    const second = new URL("https://acme.example/careers?page=2");
    const pages: Record<string, string | Error> = {
      [origin.href]: listing([jobUrl(1), jobUrl(2)], second.href),
      [second.href]: new CrawlerFailure(
        "HTTP 503 from acme.example",
        "navigation",
      ),
      [jobUrl(1).href]: postingHtml("Role One"),
      [jobUrl(2).href]: postingHtml("Role Two"),
    };
    const result = await crawlFromSession(fakeSession(pages), origin, {
      ...input,
      maxPages: 3,
    });

    expect(result.jobs.map((j) => j.title)).toEqual(["Role One", "Role Two"]);
    expect(result.complete).toBe(false);
    expect(
      result.warnings.some((w) => w.startsWith("Stopped paginating at")),
    ).toBe(true);
  });

  it("still fails when the very first listing page cannot be read", async () => {
    await expect(
      crawlFromSession(
        fakeSession({
          [origin.href]: new CrawlerFailure("HTTP 503", "navigation"),
        }),
        origin,
        input,
      ),
    ).rejects.toThrow(/503/);
  });
});

describe("crawl caps", () => {
  it("asks the crawler for no more page loads than one session can make", () => {
    // The cross-task defect: `session.ts` chose a budget and a politeness
    // gap, `browser.ts` chose page and job caps, and the two numbers
    // contradicted each other by more than an order of magnitude. Both are
    // now derived from one place, and this is the arithmetic that ties them.
    const loadsAsked = crawlMaxPages + crawlMaxJobs;
    expect(loadsAsked).toBeLessThanOrEqual(crawlLoadsPerSession);

    const budgetForThoseLoads =
      crawlSessionOverheadMs + loadsAsked * (crawlMinGapMs + crawlLoadCostMs);
    expect(budgetForThoseLoads).toBeLessThanOrEqual(crawlSessionBudgetMs);
  });

  it("refuses a request asking for more than the budget can deliver", () => {
    expect(
      crawlRequestSchema.safeParse({
        url: "https://acme.example/careers",
        maxPages: 20,
        maxJobs: 500,
      }).success,
    ).toBe(false);
    expect(
      crawlRequestSchema.parse({ url: "https://acme.example/careers" }),
    ).toMatchObject({ maxPages: crawlMaxPages, maxJobs: crawlMaxJobs });
  });
});
