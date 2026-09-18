import { chromium, type Browser } from "playwright";
import {
  blockedResource,
  crawlerUserAgent,
  hostAllowed,
  looksLikeCaptcha,
} from "./policy";
import { CrawlerFailure } from "./failure";
import { fetchRobots } from "./robots";

const sessionBudgetMs = 60_000;
const minGapMs = 2_000;

export interface Session {
  /** Navigates and returns settled HTML, or throws a `CrawlerFailure`. */
  open(url: URL): Promise<string>;
}

/** One session per host at a time; a second request for the host waits. */
const hostLocks = new Map<string, Promise<unknown>>();

let shared: Browser | null = null;
async function browser(): Promise<Browser> {
  if (!shared || !shared.isConnected())
    shared = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  return shared;
}

export async function withSession<T>(
  origin: URL,
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const host = origin.hostname;
  const previous = hostLocks.get(host) ?? Promise.resolve();

  // The resolver must exist before we ever `await`. Deriving `gate` from a
  // `.then()` callback (as a naive version does) only assigns the resolver
  // once that callback runs, which is not guaranteed to have happened by the
  // time `await previous` below resumes — leaving `release` possibly
  // undefined when `finally` calls it. Building the promise and capturing its
  // resolver synchronously, then publishing it to the map, removes that gap
  // entirely: by the time anything can await this session, the release
  // function already exists.
  let release!: () => void;
  const ours = new Promise<void>((resolve) => (release = resolve));
  const gate = previous.then(() => ours);
  hostLocks.set(host, gate);
  await previous;

  const deadline = Date.now() + sessionBudgetMs;
  const rules = await fetchRobots(origin);
  const context = await (
    await browser()
  ).newContext({
    userAgent: crawlerUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ),
    javaScriptEnabled: true,
    acceptDownloads: false,
    httpCredentials: undefined,
    // Test-only: the e2e fixture origin uses a self-signed certificate. Never
    // set this in Compose or CI's deployed environment.
    ignoreHTTPSErrors: process.env.CRAWLER_INSECURE_TLS === "1",
  });
  let lastLoad = 0;
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      let target: URL;
      try {
        target = new URL(request.url());
      } catch {
        return route.abort();
      }
      if (blockedResource(request.resourceType())) return route.abort();
      if (!hostAllowed(target, origin)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const session: Session = {
      async open(url) {
        if (Date.now() > deadline)
          throw new CrawlerFailure("Crawl session budget exhausted", "timeout");
        if (!hostAllowed(url, origin))
          throw new CrawlerFailure(
            `Navigation off-host: ${url.href}`,
            "navigation",
          );
        if (!robotsPermits(rules, url))
          throw new CrawlerFailure(
            `robots.txt disallows ${url.href}`,
            "blocked",
          );
        const wait = minGapMs - (Date.now() - lastLoad);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastLoad = Date.now();
        const response = await page
          .goto(url.href, {
            waitUntil: "domcontentloaded",
            timeout: Math.max(1, Math.min(20_000, deadline - Date.now())),
          })
          .catch((error: Error) => {
            throw new CrawlerFailure(error.message, "navigation");
          });
        if (response && response.status() >= 400)
          throw new CrawlerFailure(
            `HTTP ${response.status()} from ${url.hostname}`,
            response.status() === 403 ? "blocked" : "navigation",
          );
        await page
          .waitForLoadState("networkidle", { timeout: 5_000 })
          .catch(() => {});
        const html = await page.content();
        if (looksLikeCaptcha(html))
          throw new CrawlerFailure(
            "The site presented a challenge page; automated access is declined",
            "captcha",
          );
        return html;
      },
    };
    return await run(session);
  } finally {
    await context.close().catch(() => {});
    release();
    // Only the last waiter's release should clear the map entry. If another
    // call arrived while we held the lock, it already replaced our `gate`
    // with its own in the map (using `gate` as its `previous`); deleting the
    // key in that case would drop its lock entirely. Comparing by identity
    // tells us whether we are still the most recent entry for this host.
    if (hostLocks.get(host) === gate) hostLocks.delete(host);
  }
}

function robotsPermits(
  rules: Awaited<ReturnType<typeof fetchRobots>>,
  url: URL,
): boolean {
  return rules.allows(`${url.pathname}${url.search}`);
}
