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
  insecureModeAllowed,
  looksLikeCaptcha,
  navigationChain,
  refuseHop,
  refuseNavigationChain,
  resolvesToPublicAddress,
  type HopRefusal,
} from "./policy";
import {
  crawlLockWaitMs,
  crawlMinGapMs,
  crawlSessionBudgetMs,
} from "@jobfinder/shared";
import { CrawlerFailure } from "./failure";
import { fetchRobots } from "./robots";

/**
 * Whether the browser context should skip TLS certificate verification.
 * Test-only: the e2e fixture origin uses a self-signed certificate. Never
 * set `CRAWLER_INSECURE_TLS` in Compose's production `crawler` service or
 * in CI's deployed environment. `insecureModeAllowed()` (`policy.ts`) is
 * checked first and wins outright, via the same shared allow-list as
 * `insecureTestHostnameAllowed`: `NODE_ENV` must be an explicit, known
 * non-production value, not merely anything-but-"production" (fix round 2,
 * P3). Extracted to a named, exported function — rather than inlined in the
 * `newContext()` call below — specifically so a unit test can pin this gate
 * directly, the way `tests/unit/crawler-policy.test.ts` already does for
 * `insecureTestHostnameAllowed`; the failure mode this branch has hit twice
 * is a fix whose test does not actually exercise the fixed code path.
 */
export function tlsVerificationDisabled(): boolean {
  return insecureModeAllowed() && process.env.CRAWLER_INSECURE_TLS === "1";
}

/**
 * Both imported, not restated: the page/job caps the connector asks for are
 * *derived* from these two numbers in `packages/shared/src/crawler.ts`, and
 * the whole point of that file is that the budget and the caps cannot drift
 * apart again. A local `const` here is how they drifted the first time.
 */
const sessionBudgetMs = crawlSessionBudgetMs;
const defaultMinGapMs = crawlMinGapMs;
/** Consistent with the connector transport's default (`packages/job-sources`). */
const maxHtmlBytes = 8 * 1024 * 1024;
/** A captured API response is a few pages of JSON, not a data export. */
const maxJsonBytes = 4 * 1024 * 1024;

/** The slice of a Playwright `Request` that a captured pattern can replay. */
export interface CapturedJsonRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
}

export interface Session {
  /** Navigates and returns settled HTML, or throws a `CrawlerFailure`. */
  open(url: URL): Promise<string>;
  /** Called for every same-origin JSON response the page receives. */
  onJsonResponse(
    handler: (request: CapturedJsonRequest, body: unknown) => Promise<void>,
  ): void;
  /**
   * Called with a short, plain-language reason whenever a same-origin JSON
   * response looked like an API candidate (right verb, host, status 200,
   * JSON content type) but was dropped before it could reach
   * `onJsonResponse` — oversize or unparsable.
   */
  onJsonSkip(handler: (url: string, reason: string) => void): void;
  /** Resolves once the network has been idle, capped at 20 s. */
  settle(): Promise<void>;
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
  // Incremented by reset(). An observation started before a reset can still
  // be awaiting `refuseHop` when the reset runs (DNS lookups are not
  // cancellable — see `resolvesToPublicAddress`), so its callback captures
  // the generation it belongs to and refuses to write into a later one. This
  // is what makes `reset()` an actual boundary rather than just a hint: a
  // refusal that resolves late is a refusal about the page that was already
  // replaced, and must be discarded, not latched onto the new page.
  let generation = 0;
  return {
    observe(href) {
      // `about:blank` carries no content and reaches no host; refusing it
      // would turn Playwright's own blank starting document into a policy
      // failure.
      if (href === "about:blank") return;
      const mine = generation;
      pending = pending.then(async () => {
        if (refusal) return;
        const found = await refuseHop(href, origin, isPublic);
        if (found && !refusal && mine === generation) refusal = found;
      });
    },
    reset() {
      generation += 1;
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
  const jsonHandlers: Array<
    (request: CapturedJsonRequest, body: unknown) => Promise<void>
  > = [];
  // Reasons a candidate response (right verb, host, status, content type) was
  // dropped before it could reach `onJsonResponse` — oversize or unparsable.
  // The mundane misses (wrong verb, wrong host, non-200, non-JSON) are not
  // reported here: on a page with `blockedResource` already stripping
  // images/fonts/css/media, everything left in `page.on("response")` is
  // documents, scripts and XHR/fetch, so most of those "misses" are just
  // ordinary script loads — reporting every one would drown the two
  // categories that actually have a user-visible consequence (this response
  // looked like an API call and got dropped anyway) in noise.
  const skipHandlers: Array<(url: string, reason: string) => void> = [];
  // Registered once, unconditionally: `context.route` (in `withSession`)
  // already refused any request off-host or resolving to a private address
  // before it could ever produce a response here, so this listener only
  // needs to apply the capture-specific filters — it is not a second copy of
  // the security boundary, just downstream of it. A crawl that never calls
  // `onJsonResponse` pays for an empty array iteration per response, which is
  // noise, not cost.
  page.on("response", (response) => {
    void (async () => {
      if (jsonHandlers.length === 0) return;
      const request = response.request();
      const method = request.method();
      // `capturedRequestSchema` only has room for the two verbs a JSON API
      // realistically uses to list postings; anything else (HEAD, PUT,
      // DELETE, ...) is skipped rather than coerced into a shape that would
      // misrepresent what the page actually did.
      if (method !== "GET" && method !== "POST") return;
      let target: URL;
      try {
        target = new URL(response.url());
      } catch {
        return;
      }
      if (!hostAllowed(target, origin)) return;
      if (response.status() !== 200) return;
      const contentType = response.headers()["content-type"] ?? "";
      if (!contentType.toLowerCase().includes("json")) return;
      const reportSkip = (reason: string) => {
        for (const handler of skipHandlers) handler(response.url(), reason);
      };
      // Checked against the *declared* size before ever calling `body()`: a
      // hostile page can otherwise force a multi-hundred-MB allocation
      // before the byteLength check below gets a chance to reject it. A
      // header is a claim, not a fact, so a missing or non-numeric one falls
      // straight through to that check as the backstop.
      const declaredLength = Number(response.headers()["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength >= maxJsonBytes) {
        reportSkip(
          `declares a ${declaredLength}-byte body, at or over the ${maxJsonBytes}-byte capture limit`,
        );
        return;
      }
      let raw: Buffer;
      try {
        // A response can fail to materialise a body at all — the page
        // navigated away, the connection dropped mid-read — and that is a
        // missed capture opportunity, not a session failure.
        raw = await response.body();
      } catch {
        return;
      }
      if (raw.byteLength >= maxJsonBytes) {
        reportSkip(
          `is ${raw.byteLength} bytes, at or over the ${maxJsonBytes}-byte capture limit`,
        );
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        // Malformed JSON (or a JSON content-type on a non-JSON body, which
        // happens) is skipped, not fatal — one bad response must not abort
        // capture for the whole page.
        reportSkip(
          "has a JSON content type but the body did not parse as JSON",
        );
        return;
      }
      const captured: CapturedJsonRequest = {
        url: request.url(),
        method,
        headers: request.headers(),
        body: method === "POST" ? request.postData() : null,
      };
      for (const handler of jsonHandlers) await handler(captured, body);
    })().catch((error: unknown) => {
      // A handler that throws — or a bug in the filtering above — must not
      // become an unhandled rejection: on this Node version that terminates
      // the whole process, taking every concurrent crawl down with it for
      // one untrusted page's response. Logging it, rather than swallowing it
      // silently, is what keeps "every refusal is recorded" true here too:
      // this is a refusal to record one capture, not a reason to lose the
      // process.
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          event: "crawler.json_response_handler_failed",
          url: response.url(),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  return {
    async open(url) {
      if (Date.now() > deadline)
        // fatal: the budget is spent for the whole session, not just this
        // page — every remaining URL would fail the same way. `fatal` means
        // "stop opening pages", NOT "throw the harvest away": `crawl.ts`
        // catches this, keeps what it already extracted and returns
        // `complete: false`. A CAPTCHA is the one thing that still aborts
        // outright, because that is a refusal rather than a truncation.
        throw new CrawlerFailure(
          `Crawl session budget of ${Math.round(sessionBudgetMs / 1000)}s exhausted`,
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
      const wait = gap - (Date.now() - lastLoad);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastLoad = Date.now();
      // Both of these hold state from the previous page load and must not
      // leak into this one. They are reset here, immediately before `goto`,
      // with nothing in between: the politeness wait above is exactly the
      // window in which a still-settling previous page (e.g. mid-redirect
      // off-domain) can fire a stray `framenavigated`. Resetting before the
      // wait would let that stray navigation latch a refusal that names the
      // *previous* page's URL onto *this* page's session — refusing a
      // legitimate page for someone else's redirect.
      routeAbort.failure = null;
      latch.reset();
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
    onJsonResponse(handler) {
      jsonHandlers.push(handler);
    },
    onJsonSkip(handler) {
      skipHandlers.push(handler);
    },
    async settle() {
      // Capture has no navigation of its own to wait on — the page's own
      // script fires the API call — so this is the only signal available
      // that it has probably finished. The rejection is swallowed for the
      // same reason `open()`'s networkidle wait is: a page that never goes
      // idle (a polling widget, an open WebSocket) must not fail capture,
      // it just means the wait runs the full 20s.
      await page
        .waitForLoadState("networkidle", { timeout: 20_000 })
        .catch(() => {});
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

/** Held by whoever is crawling a host. Releasing twice is a no-op. */
export interface HostLock {
  release(): void;
}

/**
 * Acquires the per-host lock, or refuses.
 *
 * The wait is bounded, and that bound is the whole point. Before it existed,
 * a second request for a host already being crawled simply queued: it waited
 * out the first crawl's entire session budget and only then started its own,
 * so the *total* could be twice the budget against a client
 * (`crawler-client.ts`) that gives up at `crawlClientTimeoutMs`. The worker
 * therefore aborted a crawl that was doing real work, and got nothing back
 * for a connection it had held for two minutes.
 *
 * A refusal here is a far better answer than that. It is fast, it is typed,
 * it says in plain language that the host is busy, and the worker can retry
 * it later; an abort says nothing at all. `timeout` is the honest `kind` for
 * it out of `crawlerErrorKinds` — the request ran out of the time it was
 * willing to wait — and the shared enum is deliberately not widened for one
 * more shade of the same thing.
 *
 * Giving up does not deadlock the host. `ours` is resolved on the way out, so
 * anything already chained behind this attempt proceeds the moment the
 * *current* holder finishes; and the map entry is only dropped once `gate`
 * settles, because dropping it while the current holder is still crawling
 * would let the next arrival run concurrently with it — the one thing this
 * lock exists to prevent.
 */
export async function acquireHostLock(
  host: string,
  waitMs: number,
): Promise<HostLock> {
  const previous = hostLocks.get(host) ?? Promise.resolve();

  // The resolver must exist before we ever `await`. Deriving `gate` from a
  // `.then()` callback (as a naive version does) only assigns the resolver
  // once that callback runs, which is not guaranteed to have happened by the
  // time the wait below resumes — leaving `release` possibly undefined when
  // the caller's `finally` calls it. Building the promise and capturing its
  // resolver synchronously, then publishing it to the map, removes that gap
  // entirely: by the time anything can await this session, the release
  // function already exists.
  let finish!: () => void;
  const ours = new Promise<void>((resolve) => (finish = resolve));
  const gate = previous.then(() => ours);
  hostLocks.set(host, gate);

  // Only the last waiter's release should clear the map entry. If another
  // call arrived while we held the lock, it already replaced our `gate` with
  // its own in the map (using `gate` as its `previous`); deleting the key in
  // that case would drop its lock entirely. Comparing by identity tells us
  // whether we are still the most recent entry for this host.
  const dropIfOurs = () => {
    if (hostLocks.get(host) === gate) hostLocks.delete(host);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  // `previous` is built only from `.then()` callbacks that cannot reject, so
  // this race settles one way or the other and never throws.
  const acquired = await Promise.race<boolean>([
    previous.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, waitMs));
    }),
  ]);
  clearTimeout(timer);

  if (!acquired) {
    finish();
    void gate.then(dropIfOurs);
    throw new CrawlerFailure(
      `Another crawl is already in progress for ${host}; declined after waiting ${Math.round(
        waitMs / 1000,
      )}s for that host's turn. Try this company again shortly.`,
      "timeout",
    );
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      finish();
      dropIfOurs();
    },
  };
}

let shared: Browser | null = null;
async function browser(): Promise<Browser> {
  if (!shared || !shared.isConnected())
    shared = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  return shared;
}

export interface WithSessionOptions {
  /**
   * Wall-clock instant the request arrived, captured by `runCrawl`/
   * `runCapture` *before* the lock is awaited. Everything this request is
   * allowed to spend — queueing plus crawling — is measured from here, which
   * is what keeps the total inside the client's timeout. Defaults to now for
   * callers with no HTTP request behind them (tests).
   */
  arrivedAt?: number;
  /** How long to queue behind another crawl of this host; tests shorten it. */
  lockWaitMs?: number;
}

export async function withSession<T>(
  origin: URL,
  run: (session: Session) => Promise<T>,
  options: WithSessionOptions = {},
): Promise<T> {
  const arrivedAt = options.arrivedAt ?? Date.now();
  const lockWaitMs = options.lockWaitMs ?? crawlLockWaitMs;
  // Throws a typed "another crawl is in progress" refusal rather than
  // queueing indefinitely; nothing below runs, and nothing needs releasing,
  // because the lock was never taken.
  const lock = await acquireHostLock(origin.hostname, lockWaitMs);

  // Everything from here on must be inside the try: fetchRobots routinely
  // throws (a 401/403 robots.txt is an expected outcome, not an edge case),
  // and anything that throws before the lock is released by a `finally`
  // leaves `ours` unresolved forever — a permanent deadlock for this host,
  // plus a permanent `hostLocks` entry the identity-guarded delete can never
  // reach.
  let context: BrowserContext | undefined;
  try {
    // Two bounds, whichever is tighter. `Date.now() + sessionBudgetMs` is the
    // session's own allowance; `arrivedAt + lockWaitMs + sessionBudgetMs` is
    // the promise made to the client, measured from when the request arrived
    // rather than from whenever this session happened to get its turn. They
    // agree by construction today — the lock wait is what it is — and the
    // `min` is what keeps them agreeing if either number moves.
    const deadline = Math.min(
      Date.now() + sessionBudgetMs,
      arrivedAt + lockWaitMs + sessionBudgetMs,
    );
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
      ignoreHTTPSErrors: tlsVerificationDisabled(),
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
    lock.release();
  }
}
