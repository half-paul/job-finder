export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsRules {
  /** Lowercased agent token to its rules. `*` is the wildcard group. */
  groups: Map<string, RobotsRule[]>;
}

export class RobotsBlockedError extends Error {
  constructor(
    public readonly url: string,
    public readonly matchedRule: string,
  ) {
    super(`robots.txt disallows ${url} (${matchedRule})`);
    this.name = "RobotsBlockedError";
  }
}

/** Parses User-agent / Allow / Disallow groups. Unknown directives are ignored. */
export function parseRobots(text: string): RobotsRules {
  const groups = new Map<string, RobotsRule[]>();
  let agents: string[] = [];
  let sawRule = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === "user-agent") {
      if (sawRule) {
        agents = [];
        sawRule = false;
      }
      agents.push(value.toLowerCase());
      for (const agent of agents) if (!groups.has(agent)) groups.set(agent, []);
    } else if (directive === "allow" || directive === "disallow") {
      sawRule = true;
      if (!value && directive === "disallow") continue; // empty Disallow allows all
      for (const agent of agents)
        groups.get(agent)?.push({ allow: directive === "allow", path: value });
    }
  }
  return { groups };
}

/**
 * Rule paths come from the crawled site's robots.txt and the tested path from
 * that same site's links, so this is matched with a linear scan instead of a
 * compiled regex. Joining `*` segments with `.*` made a wildcard-heavy rule
 * backtrack catastrophically, and because matching is synchronous it hung the
 * worker's event loop where no fetch timeout or job signal could reach it.
 */
function ruleMatches(rulePath: string, path: string): boolean {
  const anchoredEnd = rulePath.endsWith("$");
  const pattern = anchoredEnd ? rulePath.slice(0, -1) : rulePath;
  const segments = pattern.split("*");
  const first = segments[0];
  if (!path.startsWith(first)) return false;
  if (segments.length === 1) return anchoredEnd ? path === first : true;
  let index = first.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const found = path.indexOf(segment, index);
    if (found === -1) return false;
    index = found + segment.length;
  }
  const last = segments[segments.length - 1];
  if (!last) return true;
  if (anchoredEnd)
    return path.length - last.length >= index && path.endsWith(last);
  return path.indexOf(last, index) !== -1;
}

/**
 * Longest-match evaluation like Google's robots parser. A group for our agent
 * replaces the wildcard group entirely; no group means everything is allowed.
 */
export function robotsAllows(
  rules: RobotsRules,
  path: string,
  agent: string,
): { allowed: boolean; matchedRule?: string } {
  const group =
    rules.groups.get(agent.toLowerCase()) ?? rules.groups.get("*") ?? [];
  let best: RobotsRule | undefined;
  for (const rule of group) {
    if (!ruleMatches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    )
      best = rule;
  }
  if (!best || best.allow) return { allowed: true };
  return { allowed: false, matchedRule: `Disallow: ${best.path}` };
}
