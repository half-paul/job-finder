import {
  discoveryAgentToken,
  discoveryUserAgent,
  parseRobots,
  robotsAllows,
  robotsContentTypeRefusal,
} from "@jobfinder/discovery";
import { CrawlerFailure } from "./failure";
import { refuseHop, resolvesToPublicAddress } from "./policy";

/** Matches Task 1's cap on the same fetch (`packages/discovery/src/transport.ts`). */
const maxRobotsBytes = 512 * 1024;
/** Matches the discovery transport's own robots.txt redirect budget. */
const maxRobotsRedirects = 3;

/**
 * Reads the body with a hard cap instead of `response.text()`, which has
 * none. An over-size robots.txt is refused rather than silently truncated —
 * a truncated ruleset could read as more permissive than the real one.
 */
async function readCapped(
  response: Response,
  hostname: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxRobotsBytes)
        throw new CrawlerFailure(
          `robots.txt for ${hostname} exceeds ${maxRobotsBytes} bytes`,
          "blocked",
        );
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Every URL this module is about to open — the initial robots.txt and each
 * redirect it is asked to follow — goes through the same hop check the
 * browser session uses. This runs before any browser context exists, so
 * without it an origin whose name resolves to an internal address would be
 * probed here and the resulting status echoed straight back to the API
 * caller in the `CrawlerFailure` text: a blind SSRF with a working oracle.
 */
async function assertHopAllowed(url: URL, origin: URL): Promise<void> {
  const refusal = await refuseHop(url.href, origin, resolvesToPublicAddress);
  if (refusal)
    throw new CrawlerFailure(
      `Refusing ${refusal.url}: ${refusal.reason}`,
      "blocked",
    );
}

/**
 * The crawler cannot reuse `RobotsCache`: that class is bound to the worker's
 * pinned-DNS transport. The rules and the verdict are the same, and come from
 * the same pure functions, so the two paths cannot drift on interpretation.
 *
 * Redirects are followed by hand (`redirect: "manual"`) rather than by
 * `fetch`: letting the runtime follow them would hand an attacker a free hop
 * past `assertHopAllowed`, which is the whole point of checking.
 */
export async function fetchRobots(
  origin: URL,
): Promise<{ allows(path: string): boolean }> {
  let url = new URL(`${origin.origin}/robots.txt`);
  let response: Response;
  for (let hop = 0; ; hop++) {
    await assertHopAllowed(url, origin);
    try {
      // `origin.origin` (not a hand-built `https://${hostname}`) preserves a
      // non-default port — dropping it sent every non-443 origin, including
      // the e2e fixture's ephemeral port, to the wrong endpoint.
      //
      // The e2e fixture's self-signed certificate is NOT handled here. A
      // per-request `dispatcher` option was tried and reverted: Node bundles
      // undici 7.x internally for the global `fetch`, the standalone `undici`
      // package installs 8.x, and the v8 `Agent` rejected requests built by
      // Node's own v7 handler outright — breaking every robots fetch,
      // including ones with a perfectly valid certificate. The test
      // environment instead relaxes TLS at container startup
      // (`NODE_TLS_REJECT_UNAUTHORIZED=0`, set only on the e2e crawler
      // container). Do not reintroduce a dispatcher here.
      response = await fetch(url.href, {
        headers: { "user-agent": discoveryUserAgent, accept: "text/plain" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // DNS failure, connection refused, TLS rejection, or the timeout above
      // all land here as a raw TypeError/DOMException. Wrapped so the caller
      // gets a plain-language 422 refusal instead of an unhandled 500.
      throw new CrawlerFailure(
        `Cannot reach robots.txt for ${origin.hostname}: ${
          error instanceof Error ? error.message : "network error"
        }`,
        "blocked",
      );
    }
    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get("location")
        : null;
    if (!location) break;
    if (hop >= maxRobotsRedirects)
      throw new CrawlerFailure(
        `robots.txt for ${origin.hostname} redirected more than ${maxRobotsRedirects} times`,
        "blocked",
      );
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new CrawlerFailure(
        `robots.txt for ${origin.hostname} redirected to an unusable location`,
        "blocked",
      );
    }
    // Nothing reads a redirect's body; releasing it now keeps the socket from
    // being held open for the rest of the loop.
    await response.body?.cancel().catch(() => {});
    url = next;
  }
  if (response.status === 404 || response.status === 410) {
    const empty = parseRobots("");
    return {
      allows: (path) => robotsAllows(empty, path, discoveryAgentToken).allowed,
    };
  }
  if (response.status === 401 || response.status === 403)
    throw new CrawlerFailure(
      `robots.txt for ${origin.hostname} returned HTTP ${response.status}`,
      "blocked",
    );
  if (!response.ok)
    throw new CrawlerFailure(
      `Cannot verify robots.txt for ${origin.hostname}: HTTP ${response.status}`,
      "blocked",
    );
  // Shared with `RobotsCache` in `packages/discovery/src/transport.ts` rather
  // than spelled out again here: the two hand-written copies had already
  // drifted (this one accepted `text/plain-html`) and both let a response with
  // no Content-Type through to `parseRobots`, where it became an empty — that
  // is, permissive — ruleset. One implementation, one answer.
  const contentTypeRefusal = robotsContentTypeRefusal(
    response.headers.get("content-type"),
  );
  if (contentTypeRefusal)
    throw new CrawlerFailure(
      `Cannot verify robots.txt for ${origin.hostname}: ${contentTypeRefusal}`,
      "blocked",
    );
  const rules = parseRobots(await readCapped(response, origin.hostname));
  return {
    allows: (path) => robotsAllows(rules, path, discoveryAgentToken).allowed,
  };
}
