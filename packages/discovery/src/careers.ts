import type { TransportOptions } from "@jobfinder/job-sources";
import { registrableDomain } from "./seed-list";
import {
  discoveryFetch,
  type DiscoveryFetchResult,
  type RobotsCache,
} from "./transport";
import { RobotsBlockedError } from "./robots";

export const careersProbePaths = [
  "/careers",
  "/jobs",
  "/careers/jobs",
  "/company/careers",
  "/about/careers",
] as const;

export const atsHostPattern =
  /(^|\.)(boards\.greenhouse\.io|job-boards\.greenhouse\.io|boards-api\.greenhouse\.io|jobs\.lever\.co|api\.lever\.co|jobs\.ashbyhq\.com|api\.ashbyhq\.com|myworkdayjobs\.com|jobs\.smartrecruiters\.com|icims\.com|taleo\.net)$/i;

const strongTerms = [
  "careers",
  "career",
  "jobs",
  "open positions",
  "open roles",
  "opportunities",
  "join us",
  "join our team",
  "work with us",
  "we're hiring",
  "we are hiring",
  "employment",
];

/**
 * Whether a link presents itself as this site's careers link. Used to decide
 * if a bare anchor may corroborate an ATS detection, where a footer or
 * partner link to another company's board otherwise would.
 */
export const careersSignal =
  /career|job|hiring|open|role|position|vacanc|recruit|apply|talent|join|employment/i;

export function extractAnchors(html: string, base: URL) {
  const anchors: { href: URL; text: string }[] = [];
  const pattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      const href = new URL(match[1], base);
      if (href.protocol !== "https:" && href.protocol !== "http:") continue;
      href.protocol = "https:";
      href.hash = "";
      const text = match[2]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      anchors.push({ href, text });
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return anchors;
}

/**
 * Links whose text or path reads like a careers destination. Blog posts about
 * jobs score lower than a `/careers` path; third-party hosts are excluded
 * unless they are a recognised ATS.
 */
export function scoreCareersLinks(html: string, base: URL, domain: string) {
  const scored = new Map<string, { url: URL; score: number }>();
  for (const { href, text } of extractAnchors(html, base)) {
    const sameDomain = registrableDomain(href.hostname) === domain;
    if (!sameDomain && !atsHostPattern.test(href.hostname)) continue;
    const path = href.pathname.toLowerCase();
    const lowerText = text.toLowerCase();
    let score = 0;
    for (const term of strongTerms) {
      if (lowerText === term) score += 6;
      else if (lowerText.includes(term)) score += 3;
      if (
        path.split("/").some((segment) => segment === term.replace(/ /g, "-"))
      )
        score += 5;
      else if (path.includes(term.replace(/ /g, "-"))) score += 1;
    }
    if (/\/blog\//.test(path) || /\/news\//.test(path)) score -= 4;
    if (!sameDomain) score += 2; // an ATS link is a strong signal
    if (score <= 0) continue;
    const key = href.href;
    const existing = scored.get(key);
    if (!existing || existing.score < score)
      scored.set(key, { url: href, score });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score);
}

async function tryFetch(
  url: URL,
  options: TransportOptions & {
    robots: RobotsCache;
    onProgress?: (stage: string, message: string) => Promise<void>;
  },
): Promise<DiscoveryFetchResult | null> {
  try {
    const result = await discoveryFetch(url, options);
    return result.status === 200 && result.text.trim() ? result : null;
  } catch (error) {
    if (error instanceof RobotsBlockedError) throw error;
    return null;
  }
}

/**
 * Homepage first (`https://{domain}/`, then `https://www.{domain}/`), best
 * scoring link next, then the fixed probe list. Robots refusals propagate so
 * the caller records `Blocked` instead of silently trying the next path.
 */
export async function findCareersPage(
  domain: string,
  options: TransportOptions & {
    robots: RobotsCache;
    onProgress?: (stage: string, message: string) => Promise<void>;
  },
): Promise<DiscoveryFetchResult | null> {
  const home =
    (await tryFetch(new URL(`https://${domain}/`), options)) ??
    (await tryFetch(new URL(`https://www.${domain}/`), options));
  const base = home?.finalUrl ?? new URL(`https://${domain}/`);
  if (home) {
    const links = scoreCareersLinks(home.text, home.finalUrl, domain);
    for (const best of links.slice(0, 5)) {
      const page = await tryFetch(best.url, options);
      if (page) return page;
    }
  }
  for (const path of careersProbePaths) {
    const page = await tryFetch(new URL(path, base), options);
    if (page) return page;
  }
  return null;
}
