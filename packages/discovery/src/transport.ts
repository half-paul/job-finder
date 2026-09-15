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
 * One robots.txt fetch per host per resolver run. A missing, failing or
 * unreadable file allows everything, which matches how crawlers treat 404s;
 * a reachable file is honoured exactly.
 */
export class RobotsCache {
  private readonly rules = new Map<string, Promise<RobotsRules>>();
  constructor(private readonly options: TransportOptions) {}

  private load(host: string): Promise<RobotsRules> {
    let pending = this.rules.get(host);
    if (!pending) {
      pending = (async () => {
        try {
          const { response, text } = await fetchText(
            new URL(`https://${host}/robots.txt`),
            { Accept: "text/plain" },
            { ...this.options, maxBytes: 512 * 1024 },
          );
          return response.ok ? parseRobots(text) : parseRobots("");
        } catch {
          return parseRobots("");
        }
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
  options: TransportOptions & { robots: RobotsCache },
): Promise<DiscoveryFetchResult> {
  const { robots, ...transport } = options;
  let current = new URL(url.href);
  const chain: string[] = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertHttpsUrl(current);
    await robots.assertAllowed(current);
    chain.push(current.href);
    const { response, text } = await fetchText(
      current,
      {
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
      },
      transport,
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
