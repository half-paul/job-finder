import { describe, expect, it } from "vitest";
import { crawlResponseSchema, type CrawlRequest } from "@jobfinder/shared";
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

const input: CrawlRequest = { url: "", maxPages: 1, maxJobs: 500 };
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
