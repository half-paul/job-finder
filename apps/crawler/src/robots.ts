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
  const response = await fetch(`https://${origin.hostname}/robots.txt`, {
    headers: { "user-agent": discoveryUserAgent, accept: "text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
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
