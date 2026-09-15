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

function ruleMatches(rulePath: string, path: string): boolean {
  const pattern = rulePath
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const anchored = pattern.endsWith("\\$")
    ? `^${pattern.slice(0, -2)}$`
    : `^${pattern}`;
  return new RegExp(anchored).test(path);
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
