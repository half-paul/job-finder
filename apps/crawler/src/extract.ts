import { extractJsonLdJobs, type JsonLdJob } from "@jobfinder/job-sources";
import { hostAllowed } from "./policy";

const anchorPattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

const stripTags = (value: string) =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A posting path carries a slug plus a job word or a numeric id. */
const postingPath =
  /\/(job|jobs|position|positions|opening|openings|role|roles|career|careers|vacancy|vacancies)\b[^?]*\/[^/?]+|\/[^/?]*-\d{3,}/i;

/** Same-host links that look like an individual posting, in document order. */
export function postingLinks(html: string, base: URL): URL[] {
  const seen = new Set<string>();
  const links: URL[] = [];
  anchorPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html))) {
    let href: URL;
    try {
      href = new URL(match[1], base);
    } catch {
      continue;
    }
    href.hash = "";
    if (!hostAllowed(href, base)) continue;
    if (href.href === base.href) continue;
    if (!postingPath.test(href.pathname)) continue;
    if (seen.has(href.href)) continue;
    seen.add(href.href);
    links.push(href);
  }
  return links;
}

const nextMarkers = [/rel=["']next["']/i];

/**
 * Only a real link counts. A `Load more` button is script-driven, and the
 * session clicks it rather than navigating, so it is not a page link.
 */
export function nextPageLink(html: string, base: URL): URL | null {
  anchorPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html))) {
    const tag = match[0];
    const text = stripTags(match[2]).toLowerCase();
    const isNext =
      nextMarkers.some((marker) => marker.test(tag)) || text === "next";
    if (!isNext) continue;
    try {
      const href = new URL(match[1], base);
      href.hash = "";
      if (hostAllowed(href, base) && href.href !== base.href) return href;
    } catch {
      continue;
    }
  }
  return null;
}

const titlePattern = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const locationPattern =
  /<[^>]+(?:class|id|data-[a-z-]+)=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\//i;

/**
 * JSON-LD first, because it is the site's own structured answer. The DOM
 * fallback is deliberately shallow: `h1` plus the longest text block.
 */
export function extractPosting(
  html: string,
  url: URL,
): {
  title: string;
  location: string;
  description: string;
  postedAt: string | null;
} | null {
  void url;
  const [structured] = extractJsonLdJobs(html);
  if (structured?.title.trim()) {
    return {
      title: structured.title.trim(),
      location: jsonLdLocation(structured),
      description: stripTags(structured.description ?? ""),
      postedAt: structured.datePosted ?? null,
    };
  }
  const title = stripTags(titlePattern.exec(html)?.[1] ?? "");
  if (!title) return null;
  return {
    title,
    location: stripTags(locationPattern.exec(html)?.[1] ?? ""),
    description: stripTags(html).slice(0, 20_000),
    postedAt: null,
  };
}

/**
 * `jobLocation` is `{ address? } | { address? }[] | null` in `jsonLdJobSchema`,
 * and `addressCountry` is either a string or `{ name? }`. Take the first entry.
 */
function jsonLdLocation(job: JsonLdJob): string {
  const location = Array.isArray(job.jobLocation)
    ? job.jobLocation[0]
    : job.jobLocation;
  const address = location?.address;
  if (!address) return "";
  const country =
    typeof address.addressCountry === "string"
      ? address.addressCountry
      : (address.addressCountry?.name ?? "");
  return [address.addressLocality, address.addressRegion, country]
    .filter((value): value is string => !!value?.trim())
    .join(", ");
}
