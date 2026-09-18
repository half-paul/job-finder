import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  blockedResource,
  crawlerUserAgent,
  hostAllowed,
  looksLikeCaptcha,
  navigationChain,
  refuseHop,
  refuseNavigationChain,
  resolvesToPublicAddress,
  type HopRefusal,
} from "./policy";
import { CrawlerFailure } from "./failure";
import { fetchRobots } from "./robots";

const sessionBudgetMs = 60_000;
const defaultMinGapMs = 2_000;
/** Consistent with the connector transport's default (`packages/job-sources`). */
const maxHtmlBytes = 8 * 1024 * 1024;

export interface Session {
  /** Navigates and returns settled HTML, or throws a `CrawlerFailure`. */
  open(url: URL): Promise<string>;
}

/** Turns a hop refusal into the failure the API caller sees. */
function refused(refusal: HopRefusal): CrawlerFailure {
  return new CrawlerFailure(
    `Refusing ${refusal.url}: ${refusal.reason}`,
    "blocked",
  );
}

/**
 * The route handler cannot throw a `CrawlerFailure` through Playwright's route
 * API, so when it aborts a navigation for policy it leaves the reason here and
 * `open()` re-throws it instead of Playwright's generic "aborted" message.
 */
export interface RouteAbort {
  failure: CrawlerFailure | null;
}

export interface NavigationLatch {
  /** Called for every main-frame navigation; validation runs in the background. */
  observe(href: string): void;
  /** Forget anything recorded for the previous page load. */
  reset(): void;
  /** Awaits every observation so far and returns the first refusal, if any. */
  settle(): Promise<HopRefusal | null>;
}

/**
 * Validating `page.url()` at one instant is not enough: between the chain
 * check after `goto` and the `page.content()` read there is a `networkidle`
 * wait of up to five seconds, and a `<meta refresh>` or a scripted
 * `location.href` can commit a fresh navigation inside that window. A direct
 * jump to a private host is still aborted by the route handler, but one that
 * goes through a redirect is not — that is exactly the primitive this defence
 * exists for.
 *
 * So refusals are latched rather than sampled. Every main-frame navigation is
 * validated as it commits, the first refusal is remembered, and it is still
 * remembered if the page has since navigated somewhere innocuous. A
 * navigation cannot be outrun by a later check.
 *
 * Observations are chained onto a single promise so `settle()` waits for all
 * of them in order. Nothing in the chain rejects — `refuseHop` returns its
 * verdict rather than throwing — so there is no unhandled rejection to leak.
 */
export function createNavigationLatch(
  origin: URL,
  isPublic: (hostname: string) => Promise<boolean>,
): NavigationLatch {
  let refusal: HopRefusal | null = null;
  let pending: Promise<void> = Promise.resolve();
  return {
    observe(href) {
      // `about:blank` carries no content and reaches no host; refusing it
      // would turn Playwright's own blank starting document into a policy
      // failure.
      if (href === "about:blank") return;
      pending = pending.then(async () => {
        if (refusal) return;
        const found = await refuseHop(href, origin, isPublic);
        if (found && !refusal) refusal = found;
      });
    },
    reset() {
      refusal = null;
      pending = Promise.resolve();
    },
    async settle() {
      await pending;
      return refusal;
    },
  };
}

/**
 * Installs the latch on a page's **main frame only**. An iframe navigating to
 * a third-party host is an ordinary, expected thing on a careers page and
 * must not be reported as the reason the top-level page was refused; the
 * route handler already aborts iframe requests that break policy.
 */
export function watchNavigations(page: Page, latch: NavigationLatch): void {
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) latch.observe(frame.url());
  });
}

export interface SessionDeps {
  page: Page;
  origin: URL;
  rules: { allows(path: string): boolean };
  isPublic: (hostname: string) => Promise<boolean>;
  latch: NavigationLatch;
  routeAbort: RouteAbort;
  /** Wall-clock instant the whole session must be finished by. */
  deadline: number;
  /** Politeness gap between page loads; tests set it to zero. */
  minGapMs?: number;
}

/**
 * The real `open()`, separated from the browser/lock/robots plumbing in
 * `withSession` so a test can drive it against a page it controls. Every
 * ordering guarantee this module makes lives in here.
 */
export function createSession(deps: SessionDeps): Session {
  const { page, origin, rules, isPublic, latch, routeAbort, deadline } = deps;
  const gap = deps.minGapMs ?? defaultMinGapMs;
  let lastLoad = 0;
  return {
    async open(url) {
      if (Date.now() > deadline)
        // fatal: the budget is spent for the whole session, not just this
        // page — every remaining URL would fail the same way.
        throw new CrawlerFailure(
          "Crawl session budget exhausted",
          "timeout",
          true,
        );
      if (!hostAllowed(url, origin))
        throw new CrawlerFailure(
          `Navigation off-host: ${url.href}`,
          "navigation",
        );
      if (!rules.allows(`${url.pathname}${url.search}`))
        throw new CrawlerFailure(`robots.txt disallows ${url.href}`, "blocked");
      // Both of these hold state from the previous page load and must not
      // leak into this one.
      routeAbort.failure = null;
      latch.reset();
      const wait = gap - (Date.now() - lastLoad);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastLoad = Date.now();
      const response = await page
        .goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, Math.min(20_000, deadline - Date.now())),
        })
        .catch((error: Error) => {
          // A route abort for a non-public address is the real cause of
          // this rejection; report that specifically instead of the
          // generic navigation failure Playwright raises for an aborted
          // request.
          if (routeAbort.failure) throw routeAbort.failure;
          // Playwright's own timeout (this one page loaded slowly) is
          // identifiable by name; anything else is a genuine navigation
          // failure (DNS, connection reset, etc). This is deliberately
          // NOT fatal: a single slow page does not mean the session
          // budget is spent, so the crawl should skip it and continue —
          // unlike the budget check above, which is.
          const kind = error.name === "TimeoutError" ? "timeout" : "navigation";
          throw new CrawlerFailure(error.message, kind);
        });
      // Before the status is read and long before the HTML is: with
      // `route.continue()`, a 302 produces exactly one route event — for
      // the URL we asked for — and Chromium then follows the redirect
      // internally, so the route handler never sees the target. A careers
      // page that redirects to `http://169.254.169.254/` would otherwise be
      // fetched and its body returned to the caller. Checking the status
      // first would leak too: the refused host's HTTP code would reach the
      // caller in the failure message.
      const arrival = await refuseNavigationChain(
        navigationChain(response, page.url()),
        origin,
        isPublic,
      );
      if (arrival) throw refused(arrival);
      if (response && response.status() >= 400)
        throw new CrawlerFailure(
          `HTTP ${response.status()} from ${url.hostname}`,
          response.status() === 403 ? "blocked" : "navigation",
        );
      await page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => {});
      // The settle window above is where a `<meta refresh>` lands. Re-check
      // immediately before the read, with nothing whatsoever in between: the
      // latch reports any main-frame navigation that happened during the
      // wait, and `page.url()` covers where we are standing now.
      const beforeRead =
        (await latch.settle()) ??
        (await refuseNavigationChain([page.url()], origin, isPublic));
      if (beforeRead) throw refused(beforeRead);
      const html = await page.content();
      // And once more after the read, because `page.content()` is itself an
      // await: a navigation that commits while it is in flight would be
      // reflected in `html`. Re-checking here means the HTML is discarded
      // rather than returned. This is the check that makes the guarantee
      // total — no refused navigation's content can reach the caller.
      const afterRead = await latch.settle();
      if (afterRead) throw refused(afterRead);
      // A refusal, not a silent truncation: the caller needs to know this
      // page was skipped for its size, not receive a chopped-off posting.
      if (Buffer.byteLength(html, "utf8") > maxHtmlBytes)
        throw new CrawlerFailure(
          `Page content for ${url.href} exceeds ${maxHtmlBytes} bytes`,
          "blocked",
        );
      if (looksLikeCaptcha(html))
        throw new CrawlerFailure(
          "The site presented a challenge page; automated access is declined",
          "captcha",
        );
      return html;
    },
  };
}

/**
 * Runs in the page before any of its own scripts, via `addInitScript`. It must
 * therefore be self-contained: no imports, no closure over anything here.
 */
export function disableWorkers(): void {
  const Refused = class {
    constructor() {
      throw new Error(
        "Web Workers are disabled for this crawl: their WebSockets cannot be inspected",
      );
    }
  };
  for (const name of ["Worker", "SharedWorker"]) {
    if (name in globalThis)
      Object.defineProperty(globalThis, name, {
        configurable: false,
        writable: false,
        value: Refused,
      });
  }
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

  // Everything from here on must be inside the try: fetchRobots routinely
  // throws (a 401/403 robots.txt is an expected outcome, not an edge case),
  // and anything that throws before the lock is held by a `finally` leaves
  // `ours` unresolved forever — a permanent deadlock for this host, plus a
  // permanent `hostLocks` entry the identity-guarded delete can never reach.
  let context: BrowserContext | undefined;
  try {
    const deadline = Date.now() + sessionBudgetMs;
    const rules = await fetchRobots(origin);
    context = await (
      await browser()
    ).newContext({
      userAgent: crawlerUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
      javaScriptEnabled: true,
      acceptDownloads: false,
      httpCredentials: undefined,
      // Chromium does not run `context.route` over service-worker-initiated
      // requests, so a page's own SW could otherwise bypass the host
      // allowlist, the blocked resource types, and the private-address
      // check below entirely. Blocking SW registration closes that hole.
      serviceWorkers: "block",
      // Test-only: the e2e fixture origin uses a self-signed certificate. Never
      // set this in Compose or CI's deployed environment.
      ignoreHTTPSErrors: process.env.CRAWLER_INSECURE_TLS === "1",
    });
    // One DNS lookup per hostname for the life of this session, not one per
    // request: every subresource on a page shares its document's host, and
    // pagination re-visits the same host repeatedly.
    const addressCache = new Map<string, Promise<boolean>>();
    const isHostPublic = (hostname: string): Promise<boolean> => {
      let pending = addressCache.get(hostname);
      if (!pending) {
        pending = resolvesToPublicAddress(hostname);
        addressCache.set(hostname, pending);
      }
      return pending;
    };
    const routeAbort: RouteAbort = { failure: null };
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
      // Checked on every intercepted request — not only the first
      // navigation — so a redirect or a subresource load cannot reach an
      // internal address that the initial hostname check never saw.
      if (!(await isHostPublic(target.hostname))) {
        if (request.isNavigationRequest())
          routeAbort.failure = new CrawlerFailure(
            `Refusing ${target.hostname}: resolves to a non-public address`,
            "blocked",
          );
        return route.abort();
      }
      return route.continue();
    });
    // `context.route` does not intercept WebSockets at all, so without this a
    // page's own JavaScript could open `wss://internal-host/` and read the
    // answer with none of the checks above applied. Playwright 1.63 does
    // expose `routeWebSocket`, so we can hold every socket and decide.
    //
    // The matcher is `() => true` deliberately: a URL pattern that failed to
    // match would leave that socket unrouted and therefore unchecked, which
    // is the failure mode we are here to remove. A refused socket is closed
    // with 1008 ("policy violation") and a reason the page can see; an
    // allowed one is joined to the real server with `connectToServer()`.
    // Playwright does not open a server connection unless that is called, so
    // the `await` below cannot leak a connection while it resolves.
    await context.routeWebSocket(
      () => true,
      async (ws) => {
        const refuse = (reason: string) => ws.close({ code: 1008, reason });
        let target: URL;
        try {
          target = new URL(ws.url());
        } catch {
          return refuse("Unusable WebSocket URL");
        }
        // `hostAllowed` speaks HTTP(S); `wss:`/`ws:` map onto `https:`/`http:`
        // one-for-one, and the `ws:` mapping to `http:` is what makes an
        // unencrypted socket fail the same HTTPS-only rule a page load does.
        const asHttp = new URL(target.href);
        asHttp.protocol = target.protocol === "ws:" ? "http:" : "https:";
        if (!hostAllowed(asHttp, origin))
          return refuse("WebSocket host is not allowed for this crawl");
        if (!(await isHostPublic(target.hostname)))
          return refuse("WebSocket host resolves to a non-public address");
        ws.connectToServer();
      },
    );
    // `routeWebSocket` covers the page and its iframes, but a *dedicated Web
    // Worker's* WebSocket is not surfaced to it in Playwright 1.63 — the
    // upgrade reaches the server unseen. A worker's `fetch()` is routed and
    // therefore already policed, so this gap is WebSocket-only, and there is
    // no interception hook to close it with.
    //
    // Refusing worker construction outright is the cheapest closure that
    // actually holds: there is no unchecked socket if there is no worker.
    // The alternative — aborting worker script loads in the route handler —
    // does not work, because Chromium reports a worker's own script as
    // resourceType "script", indistinguishable from the page's ordinary
    // scripts, so it would take every page script down with it.
    //
    // Ordinary page scripts are untouched: this redefines two constructors
    // and nothing else, before any page script runs. A page that genuinely
    // uses a worker sees a thrown Error in its own code — the same outcome
    // as an unsupported browser — while the document itself still parses,
    // renders and is read.
    await context.addInitScript(disableWorkers);
    const page = await context.newPage();
    const latch = createNavigationLatch(origin, isHostPublic);
    watchNavigations(page, latch);
    return await run(
      createSession({
        page,
        origin,
        rules,
        isPublic: isHostPublic,
        latch,
        routeAbort,
        deadline,
      }),
    );
  } finally {
    // `context` may still be undefined here — e.g. fetchRobots or the
    // browser launch threw before newContext ever ran — so this must be
    // optional, not `context.close()`.
    await context?.close().catch(() => {});
    release();
    // Only the last waiter's release should clear the map entry. If another
    // call arrived while we held the lock, it already replaced our `gate`
    // with its own in the map (using `gate` as its `previous`); deleting the
    // key in that case would drop its lock entirely. Comparing by identity
    // tells us whether we are still the most recent entry for this host.
    if (hostLocks.get(host) === gate) hostLocks.delete(host);
  }
}
