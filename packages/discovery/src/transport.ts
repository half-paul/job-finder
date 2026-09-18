import {
  assertHttpsUrl,
  fetchText,
  type TransportOptions,
} from "@jobfinder/job-sources";
import type { PolicyCheck } from "@jobfinder/shared";
import {
  parseRobots,
  robotsAllows,
  RobotsBlockedError,
  type RobotsRules,
} from "./robots";

export const discoveryUserAgent = "JobFinderBot/1.0";
const maxRedirects = 3;

/**
 * One robots.txt fetch per host per resolver run. Only 404/410 are treated
 * as missing; unavailable policy checks stop discovery rather than allowing it.
 */
export class RobotsCache {
  private readonly rules = new Map<string, Promise<RobotsRules>>();
  constructor(private readonly options: TransportOptions) {}

  private load(host: string): Promise<RobotsRules> {
    let pending = this.rules.get(host);
    if (!pending) {
      pending = (async () => {
        let url = new URL(`https://${host}/robots.txt`);
        for (let hop = 0; hop <= maxRedirects; hop++) {
          const { response, text } = await fetchText(
            url,
            { Accept: "text/plain" },
            { ...this.options, maxBytes: 512 * 1024 },
          );
          if (response.ok) return parseRobots(text);
          if ([404, 410].includes(response.status)) return parseRobots("");
          const location = response.headers.get("location");
          if (
            response.status >= 300 &&
            response.status < 400 &&
            location &&
            hop < maxRedirects
          ) {
            url = new URL(location, url);
            continue;
          }
          if ([401, 403].includes(response.status))
            throw new RobotsBlockedError(url.href, `HTTP ${response.status}`);
          throw new Error(
            `Cannot verify robots.txt for ${host}: HTTP ${response.status}.`,
          );
        }
        throw new Error("Too many robots.txt redirects.");
      })();
      this.rules.set(host, pending);
    }
    return pending;
  }

  async check(url: URL): Promise<PolicyCheck> {
    const rules = await this.load(url.hostname);
    const verdict = robotsAllows(
      rules,
      `${url.pathname}${url.search}`,
      "JobFinderBot",
    );
    return {
      robotsAllowed: verdict.allowed,
      robotsUrl: `https://${url.hostname}/robots.txt`,
      checkedAt: new Date().toISOString(),
      userAgent: discoveryUserAgent,
      ...(verdict.matchedRule ? { matchedRule: verdict.matchedRule } : {}),
    };
  }

  async assertAllowed(url: URL): Promise<PolicyCheck> {
    const check = await this.check(url);
    if (!check.robotsAllowed)
      throw new RobotsBlockedError(url.href, check.matchedRule ?? "Disallow");
    return check;
  }
}

export interface DiscoveryFetchResult {
  finalUrl: URL;
  chain: string[];
  status: number;
  text: string;
  contentType: string;
}

/**
 * The connector transport never follows redirects. Discovery needs to, because
 * homepages bounce to `www.` and careers links bounce to ATS hosts. Every hop
 * is re-validated: HTTPS, public address, robots.
 */
export async function discoveryFetch(
  url: URL,
  options: TransportOptions & {
    robots: RobotsCache;
    onProgress?: (stage: string, message: string) => Promise<void>;
    allowUrl?: (url: URL) => boolean;
  },
): Promise<DiscoveryFetchResult> {
  const { robots, onProgress, allowUrl, ...transport } = options;
  let current = new URL(url.href);
  const chain: string[] = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertHttpsUrl(current);
    if (allowUrl && !allowUrl(current))
      throw new Error(
        "Careers navigation left the approved company or ATS hosts.",
      );
    await onProgress?.("robots", `Checking robots.txt for ${current.hostname}`);
    await robots.assertAllowed(current);
    await onProgress?.(
      "fetch",
      `Fetching ${current.origin}${current.pathname}`,
    );
    chain.push(current.href);
    const { response, text } = await fetchText(
      current,
      {
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
      },
      transport,
    );
    await onProgress?.(
      "http",
      `HTTP ${response.status} from ${current.hostname}`,
    );
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === maxRedirects) throw new Error("Too many redirects");
      current = new URL(location, current);
      continue;
    }
    return {
      finalUrl: current,
      chain,
      status: response.status,
      text,
      contentType: response.headers.get("content-type") ?? "",
    };
  }
  throw new Error("Too many redirects");
}
