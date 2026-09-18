import {
  discoveryAgentToken,
  discoveryUserAgent,
  parseRobots,
  robotsAllows,
} from "@jobfinder/discovery";
import { CrawlerFailure } from "./failure";

/**
 * The crawler cannot reuse `RobotsCache`: that class is bound to the worker's
 * pinned-DNS transport. The rules and the verdict are the same, and come from
 * the same pure functions, so the two paths cannot drift on interpretation.
 */
export async function fetchRobots(
  origin: URL,
): Promise<{ allows(path: string): boolean }> {
  let response: Response;
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
    response = await fetch(`${origin.origin}/robots.txt`, {
      headers: { "user-agent": discoveryUserAgent, accept: "text/plain" },
      redirect: "follow",
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
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/^\s*text\/plain\b/i.test(contentType))
    throw new CrawlerFailure(
      `Cannot verify robots.txt for ${origin.hostname}: unexpected content type ${contentType}`,
      "blocked",
    );
  const rules = parseRobots(await response.text());
  return {
    allows: (path) => robotsAllows(rules, path, discoveryAgentToken).allowed,
  };
}
