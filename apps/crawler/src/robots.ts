import { Agent } from "undici";
import {
  discoveryAgentToken,
  discoveryUserAgent,
  parseRobots,
  robotsAllows,
} from "@jobfinder/discovery";
import { CrawlerFailure } from "./failure";

/**
 * Node's global `fetch` accepts a non-standard `dispatcher` option that
 * lib.dom's `RequestInit` does not declare, so it is added here rather than
 * asserted away at the call site.
 */
type FetchInit = RequestInit & { dispatcher?: Agent };

/**
 * The crawler cannot reuse `RobotsCache`: that class is bound to the worker's
 * pinned-DNS transport. The rules and the verdict are the same, and come from
 * the same pure functions, so the two paths cannot drift on interpretation.
 */
export async function fetchRobots(
  origin: URL,
): Promise<{ allows(path: string): boolean }> {
  // `origin.origin` (not a hand-built `https://${hostname}`) preserves a
  // non-default port — dropping it sent every non-443 origin, including the
  // e2e fixture's ephemeral port, to the wrong endpoint.
  const init: FetchInit = {
    headers: { "user-agent": discoveryUserAgent, accept: "text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  };
  // Test-only: the e2e fixture serves a self-signed certificate. Never set
  // this in Compose or CI's deployed environment. Mirrors the same gate on
  // `ignoreHTTPSErrors` in session.ts, which covers the browser's requests;
  // this covers the plain `fetch` robots.txt request, which Playwright does
  // not intercept.
  if (process.env.CRAWLER_INSECURE_TLS === "1")
    init.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const response = await fetch(`${origin.origin}/robots.txt`, init);
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
