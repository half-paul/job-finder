import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { CrawlerFailure } from "../../apps/crawler/src/failure";
import {
  acquireHostLock,
  createNavigationLatch,
  createSession,
  disableWorkers,
  watchNavigations,
  type RouteAbort,
} from "../../apps/crawler/src/session";

/**
 * The only test in `tests/unit` that starts a browser, and it earns the cost:
 * the leak it covers is an *ordering* bug between validating `page.url()` and
 * reading `page.content()`, which no pure test of the validator can see. The
 * pure-function tests in `crawler-policy.test.ts` proved the predicate; this
 * proves the sequence around it.
 *
 * Chromium resolves the fixture's hostnames to the loopback server through
 * `--host-resolver-rules`, and the address predicate is injected, so the two
 * sides of the check can disagree exactly as they would in the real attack:
 * a hostname that is perfectly routable to the browser and refused by policy.
 */

const secret = "INTERNAL-SECRET";
const publicHost = "acme.example";
const privateHost = "metadata.acme.example";

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "crawler-session-"));
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${publicHost}`,
    "-addext",
    `subjectAltName=DNS:${publicHost},DNS:${privateHost}`,
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ]);
  return {
    key: readFileSync(join(dir, "key.pem")),
    cert: readFileSync(join(dir, "cert.pem")),
  };
}

describe("crawler session enforcement", () => {
  let server: Server;
  let browser: Browser;
  let context: BrowserContext;
  let port = 0;
  /** Every path the fixture server was asked for, in order. */
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer(certificate(), (req, res) => {
      const path = req.url ?? "";
      hits.push(`${req.headers.host ?? ""}${path}`);
      const html = (body: string) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>${body}</body></html>`);
      };
      // A page that looks innocuous and then re-navigates itself inside the
      // `networkidle` window — the window the old code read HTML from.
      if (path === "/careers")
        return html(
          `<meta http-equiv="refresh" content="0;url=/bounce"><h1>Open roles</h1>`,
        );
      // The one redirect hop the attack needs: a direct jump to the private
      // host is aborted by the route handler, a redirect to it is not.
      if (path === "/bounce") {
        res.writeHead(302, {
          location: `https://${privateHost}:${port}/secret`,
        });
        return res.end();
      }
      if (path === "/secret") return html(`<h1>${secret}</h1>`);
      if (path === "/direct")
        return res
          .writeHead(302, { location: `https://${privateHost}:${port}/secret` })
          .end();
      if (path === "/plain") return html(`<h1>Staff Engineer</h1>`);
      // The bounce-back chain: a public page's meta refresh lands on a
      // redirect to the private host, which itself immediately bounces back
      // to an entirely legitimate public page — all inside the networkidle
      // window, before `page.url()` is ever read. `page.url()` at the end is
      // public throughout; only the latch, which observed the private hop as
      // it committed, has any record that it happened at all.
      if (path === "/careers-bounceback")
        return html(
          `<meta http-equiv="refresh" content="0;url=/bounce-to-private">`,
        );
      if (path === "/bounce-to-private")
        return res
          .writeHead(302, {
            location: `https://${privateHost}:${port}/bounce-home`,
          })
          .end();
      if (path === "/bounce-home")
        return html(
          `<meta http-equiv="refresh" content="0;url=https://${publicHost}:${port}/plain">`,
        );
      if (path === "/worker")
        return html(
          `<script>
             try {
               new Worker("data:application/javascript,void 0");
               document.title = "worker-created";
             } catch (error) {
               document.title = "refused:" + error.message;
             }
           </script>`,
        );
      res.writeHead(404).end("missing");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No port");
    port = address.port;

    browser = await chromium.launch({
      args: [
        "--disable-dev-shm-usage",
        `--host-resolver-rules=MAP ${publicHost} 127.0.0.1,MAP ${privateHost} 127.0.0.1`,
      ],
    });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript(disableWorkers);
  }, 120_000);

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    server?.close();
  });

  /** Public to the browser, private to policy — the disagreement under test. */
  const isPublic = (hostname: string) =>
    Promise.resolve(hostname !== privateHost);

  async function sessionFor(origin: URL) {
    const page = await context.newPage();
    const latch = createNavigationLatch(origin, isPublic);
    watchNavigations(page, latch);
    const routeAbort: RouteAbort = { failure: null };
    const session = createSession({
      page,
      origin,
      rules: { allows: () => true },
      isPublic,
      latch,
      routeAbort,
      deadline: Date.now() + 60_000,
      minGapMs: 0,
    });
    return { page, session };
  }

  it("refuses a meta refresh that lands on a private address, and returns no HTML", async () => {
    const origin = new URL(`https://${publicHost}:${port}/careers`);
    const { page, session } = await sessionFor(origin);
    try {
      const opened = session.open(origin);
      await expect(opened).rejects.toBeInstanceOf(CrawlerFailure);
      const error = await opened.catch((raised: unknown) => raised);
      expect(error).toMatchObject({ kind: "blocked" });
      expect((error as CrawlerFailure).message).toContain(privateHost);
      expect((error as CrawlerFailure).message).toContain(
        "resolves to a non-public address",
      );
      // The proof that matters: nothing was returned, and the secret is
      // nowhere in the failure either.
      expect((error as CrawlerFailure).message).not.toContain(secret);
      // The server did serve it — this is a read refusal, not a request
      // refusal, which is exactly what the report claims.
      expect(hits.some((hit) => hit.endsWith("/secret"))).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("refuses a private hop that bounces back to a public URL before the read", async () => {
    // Pins the latch specifically: `page.url()` at the moment of the read is
    // the public `/plain` page throughout, so a check of the settled URL
    // alone — with no latch at all — would see nothing wrong and return that
    // page's HTML. Only the latch, which recorded the private mid-chain hop
    // as it committed, can still refuse this. Verified by mutation: with
    // `latch.reset()`/`observe()` in `session.ts` short-circuited to no-ops,
    // this test fails (the promise resolves instead of rejecting); restored,
    // it passes.
    const origin = new URL(`https://${publicHost}:${port}/careers`);
    const { page, session } = await sessionFor(origin);
    try {
      const opened = session.open(
        new URL(`https://${publicHost}:${port}/careers-bounceback`),
      );
      await expect(opened).rejects.toBeInstanceOf(CrawlerFailure);
      const error = await opened.catch((raised: unknown) => raised);
      expect(error).toMatchObject({ kind: "blocked" });
      expect((error as CrawlerFailure).message).toContain(privateHost);
      expect((error as CrawlerFailure).message).toContain(
        "resolves to a non-public address",
      );
    } finally {
      await page.close();
    }
  }, 60_000);

  it("refuses a plain redirect to a private address", async () => {
    const origin = new URL(`https://${publicHost}:${port}/careers`);
    const { page, session } = await sessionFor(origin);
    try {
      await expect(
        session.open(new URL(`https://${publicHost}:${port}/direct`)),
      ).rejects.toMatchObject({ kind: "blocked" });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("still returns the HTML of a page that stays where it should", async () => {
    const origin = new URL(`https://${publicHost}:${port}/careers`);
    const { page, session } = await sessionFor(origin);
    try {
      const html = await session.open(
        new URL(`https://${publicHost}:${port}/plain`),
      );
      expect(html).toContain("Staff Engineer");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("refuses Web Worker construction without breaking ordinary page scripts", async () => {
    const origin = new URL(`https://${publicHost}:${port}/careers`);
    const { page, session } = await sessionFor(origin);
    try {
      const html = await session.open(
        new URL(`https://${publicHost}:${port}/worker`),
      );
      // The inline script ran to completion — ordinary scripts are
      // unaffected — and the Worker constructor refused.
      const title = await page.title();
      expect(title).toContain("refused:");
      expect(title).toContain("Web Workers are disabled");
      expect(html).toContain("<body>");
    } finally {
      await page.close();
    }
  }, 60_000);
});

/**
 * The bug these cover: the session deadline started once the per-host lock
 * was acquired, so two companies on one host crawled back to back — the
 * second waited out the whole of the first and only then began its own full
 * budget. Against `crawlClientTimeoutMs` that meant the worker aborted a
 * crawl that was doing real work, after holding the connection for two
 * minutes and getting nothing. A bounded wait turns that into a fast, typed
 * refusal the worker can retry.
 *
 * No browser here: `acquireHostLock` is the whole mechanism, separated from
 * `withSession` precisely so this can be proven without launching Chromium.
 * Each test uses its own hostname, because the lock map is module state.
 */
describe("the per-host lock", () => {
  it("refuses a second crawl of a busy host rather than queueing behind it", async () => {
    const host = "busy.example";
    const held = await acquireHostLock(host, 1_000);

    const started = Date.now();
    const refusal = await acquireHostLock(host, 50).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(CrawlerFailure);
    const failure = refusal as CrawlerFailure;
    expect(failure.kind).toBe("timeout");
    expect(failure.message).toContain(
      `Another crawl is already in progress for ${host}`,
    );
    // The point of the bound: it returns in its own window, not the
    // holder's. Generous here so a loaded CI box cannot flake it, and still
    // two orders of magnitude below the client timeout it exists to respect.
    expect(Date.now() - started).toBeLessThan(2_000);

    held.release();
  });

  it("lets the next request through once the holder releases", async () => {
    const host = "sequential.example";
    const first = await acquireHostLock(host, 1_000);
    let acquired = false;
    const second = acquireHostLock(host, 5_000).then((lock) => {
      acquired = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(acquired).toBe(false);

    first.release();
    (await second).release();
    expect(acquired).toBe(true);
  });

  it("does not leave the host locked after a refusal", async () => {
    // A refusal that poisoned the host would be worse than the queueing it
    // replaced: every later crawl of that company would be declined forever.
    const host = "recovers.example";
    const held = await acquireHostLock(host, 1_000);
    await expect(acquireHostLock(host, 25)).rejects.toBeInstanceOf(
      CrawlerFailure,
    );
    held.release();

    const after = await acquireHostLock(host, 1_000);
    after.release();
  });

  it("keeps one host's refusal away from another host", async () => {
    const held = await acquireHostLock("one.example", 1_000);
    const other = await acquireHostLock("two.example", 25);
    other.release();
    held.release();
  });
});
