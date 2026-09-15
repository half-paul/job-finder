const postingSegment =
  /^(jobs?|positions?|openings?|careers?|roles?|vacanc(y|ies)|opportunit(y|ies)|postings?|requisitions?)$/i;

const hostOf = (url: URL) => url.hostname.replace(/^www\./, "");

/**
 * Anchors that look like individual postings: same host as the listing page,
 * a posting-ish segment followed by at least one more segment (a slug or id).
 * `/jobs` alone is a listing, not a posting.
 */
export function collectPostingLinks(html: string, base: URL, cap = 200): URL[] {
  const seen = new Set<string>();
  const links: URL[] = [];
  const pattern = /<a\b[^>]*href=["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && links.length < cap) {
    let url: URL;
    try {
      url = new URL(match[1], base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || hostOf(url) !== hostOf(base)) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    const index = segments.findIndex((segment) => postingSegment.test(segment));
    if (index < 0 || index === segments.length - 1) continue;
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    const key = url.href;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(url);
  }
  return links;
}
