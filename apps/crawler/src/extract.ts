import {
  extractJsonLdJobs,
  htmlToText,
  type JsonLdJob,
} from "@jobfinder/job-sources";
import { hostAllowed } from "./policy";

/**
 * ## Why this file scans tags by hand instead of with `/<a\b[^>]*...>/g`
 *
 * Every pattern here used to be of the shape `<tag[^>]*...>`, run with `exec`
 * or `replace` over a whole untrusted page. That shape is quadratic on
 * adversarial input: at each of the ~n/2 positions where `<a` occurs, `[^>]*`
 * runs to the end of the document looking for a `>` that is not there, then
 * backtracks the whole way. Measured on `"<a"` repeats: 50 KB → 0.84 s,
 * 100 KB → 3.15 s, 200 KB → 11.17 s, 400 KB → 40.65 s — clean n². The page
 * cap is 8 MB (`session.ts`), so a single hostile careers page extrapolates
 * to hours of a blocked event loop, and Node is single-threaded: that one
 * page takes down every concurrent crawl and `/health` with it, and
 * `restart: unless-stopped` does not restart a merely-unhealthy container.
 *
 * `scanTags` replaces all of them with one forward pass whose cursor only
 * ever moves right, so the total work is linear in the document length no
 * matter what the document contains. The regexes that remain run only
 * against a single tag's source, which `maxTagLength` bounds, and only
 * against quote-delimited attribute runs, so they cannot re-scan the page.
 *
 * `tests/unit/crawler-extract.test.ts` pins this with pathological inputs and
 * a wall-clock assertion; if a future change reintroduces a page-wide
 * `[^>]*`, that test is what will catch it.
 */

/** Longer than any real start tag; a `<` this far from its `>` is not markup. */
const maxTagLength = 4096;
/**
 * A hard stop on the scan itself, independent of the linearity argument
 * above. 8 MB of `<p>` is about 2.6 M tags, so this only bites on documents
 * that are already pathological. Reaching it is reported, not swallowed —
 * see `ExtractionResult` below.
 */
const maxScannedTags = 300_000;
/**
 * Anchors considered on one page. A real listing has tens, not thousands.
 * Reaching it is reported the same way `maxScannedTags` is.
 */
const maxAnchors = 10_000;
/** A posting URL longer than this is not one. */
const maxHrefLength = 2_048;
/** Anchor text kept for the `next` check; link labels are a few words. */
const maxAnchorTextLength = 4_096;

/**
 * What an extraction returns: the value, plus any caps that cut the scan
 * short before it could see the whole document.
 *
 * The caps below (`maxScannedTags`, `maxAnchors`) exist to keep a hostile
 * page from monopolising a single-threaded process, and they are worth
 * keeping — but a cap that stops early and says nothing is a silent
 * refusal, which is the one thing this service is not allowed to do. So
 * every exported function reports what it gave up on, in plain language,
 * and `crawl.ts` turns each note into a bounded warning and sets
 * `complete: false` exactly as it already does for the page and job caps.
 *
 * The notes travel back as a return value rather than through a collector
 * this module writes into: these functions are pure, they are tested as pure
 * functions, and a module-level counter or a callback into `warnings.ts`
 * would make the same document extract differently depending on what ran
 * before it.
 */
export interface ExtractionResult<T> {
  value: T;
  /** Empty when nothing was cut short. One short sentence fragment each. */
  truncated: string[];
}

/**
 * Per-call, never module-level: one of these is created by each exported
 * entry point and threaded down through the scans it performs, so two
 * concurrent extractions cannot see each other's counters.
 */
interface ScanLimits {
  /** A `scanTags` walk stopped at `maxScannedTags`. */
  tags: boolean;
  /** An anchor walk stopped at `maxAnchors`. */
  anchors: boolean;
}

const newLimits = (): ScanLimits => ({ tags: false, anchors: false });

/** The plain-language notes for whatever the caps actually cut short. */
function truncationNotes(limits: ScanLimits): string[] {
  const notes: string[] = [];
  if (limits.tags)
    notes.push(
      `the page has more than ${maxScannedTags} HTML tags, so the scan stopped there`,
    );
  if (limits.anchors)
    notes.push(
      `the page has more than ${maxAnchors} links, so only the first ${maxAnchors} were examined`,
    );
  return notes;
}

interface Tag {
  /** Lowercased element name: `a`, `div`, `h1`. */
  name: string;
  /** True for a closing tag, `</a>`. */
  closing: boolean;
  selfClosing: boolean;
  /** The tag's own source, `<a href="...">`, never longer than `maxTagLength`. */
  source: string;
  /** Index of the opening `<`. */
  start: number;
  /** Index just past the closing `>`. */
  contentStart: number;
}

function isNameChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 45 // -
  );
}

/**
 * Every tag in `html` from `from` onwards, in document order.
 *
 * The linearity guarantee rests on two facts, and any change here has to keep
 * both. First, `pos` is assigned only from `indexOf` results that lie at or
 * after it, so the cursor is monotonic and the `indexOf` scans together cover
 * the document once. Second, an `indexOf` that returns -1 ends the scan
 * rather than advancing by one and trying again: if there is no `>` left in
 * the document then no later `<` can open a complete tag either, so there is
 * nothing to be gained by looking, and looking is exactly what the old
 * regexes did n/2 times over.
 */
function* scanTags(
  html: string,
  from: number,
  limits: ScanLimits,
): Generator<Tag> {
  let pos = from;
  let scanned = 0;
  while (pos < html.length) {
    if (scanned >= maxScannedTags) {
      limits.tags = true;
      return;
    }
    const start = html.indexOf("<", pos);
    if (start < 0) return;
    const end = html.indexOf(">", start + 1);
    if (end < 0) return;
    // Advanced before any `continue` below, so every path through the loop
    // moves the cursor strictly right.
    pos = end + 1;
    scanned++;
    // A `<` whose `>` is this far away is not a tag a browser would parse
    // either; skipping to past the `>` matches how a real parser recovers.
    if (end - start > maxTagLength) continue;
    let i = start + 1;
    const closing = html.charCodeAt(i) === 47; // "/"
    if (closing) i++;
    let j = i;
    while (j < end && isNameChar(html.charCodeAt(j))) j++;
    // `<` not followed by a name: a stray literal, a comment, a doctype.
    if (j === i) continue;
    yield {
      name: html.slice(i, j).toLowerCase(),
      closing,
      selfClosing: html.charCodeAt(end - 1) === 47,
      source: html.slice(start, end + 1),
      start,
      contentStart: end + 1,
    };
  }
}

/**
 * The first closing tag matching `open`, ignoring nesting — the same thing
 * the old lazy `[\s\S]*?</tag>` matched.
 */
function firstClose(html: string, open: Tag, limits: ScanLimits): Tag | null {
  for (const tag of scanTags(html, open.contentStart, limits))
    if (tag.closing && tag.name === open.name) return tag;
  return null;
}

/**
 * Runs against one tag's source only (at most `maxTagLength` characters), so
 * its `[^"'#]+` cannot scan the page. `href=` without a word boundary keeps
 * the old pattern's behaviour, including its tolerance of `data-href=`.
 */
const hrefPattern = /href=["']([^"'#]+)["']/i;

/** A posting path carries a slug plus a job word or a numeric id. */
const postingPath =
  /\/(job|jobs|position|positions|opening|openings|role|roles|career|careers|vacancy|vacancies)\b[^?]*\/[^/?]+|\/[^/?]*-\d{3,}/i;

/** Same-host links that look like an individual posting, in document order. */
export function postingLinks(html: string, base: URL): ExtractionResult<URL[]> {
  const limits = newLimits();
  const seen = new Set<string>();
  const links: URL[] = [];
  let anchors = 0;
  for (const tag of scanTags(html, 0, limits)) {
    if (tag.closing || tag.name !== "a") continue;
    if (++anchors > maxAnchors) {
      limits.anchors = true;
      break;
    }
    const raw = hrefPattern.exec(tag.source)?.[1];
    if (!raw || raw.length > maxHrefLength) continue;
    let href: URL;
    try {
      href = new URL(raw, base);
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
  return { value: links, truncated: truncationNotes(limits) };
}

const nextMarkers = [/rel=["']next["']/i];

/**
 * Only a real link counts. A `Load more` button is script-driven, and the
 * session clicks it rather than navigating, so it is not a page link.
 */
export function nextPageLink(
  html: string,
  base: URL,
): ExtractionResult<URL | null> {
  const limits = newLimits();
  let anchors = 0;
  for (const tag of scanTags(html, 0, limits)) {
    if (tag.closing || tag.name !== "a") continue;
    if (++anchors > maxAnchors) {
      limits.anchors = true;
      break;
    }
    const raw = hrefPattern.exec(tag.source)?.[1];
    if (!raw || raw.length > maxHrefLength) continue;
    // A bounded window rather than `firstClose`: an anchor that is never
    // closed would otherwise make this scan to the end of the document, once
    // per anchor, which is the very shape this file exists to avoid. A link
    // label is a few words, and the only thing read from it is
    // `text === "next"`, so 4 KB is already far more than enough.
    const window = html.slice(
      tag.contentStart,
      tag.contentStart + maxAnchorTextLength,
    );
    const closeAt = window.search(/<\/a\b/i);
    const inner = closeAt < 0 ? window : window.slice(0, closeAt);
    const isNext =
      nextMarkers.some((marker) => marker.test(tag.source)) ||
      htmlToText(inner).toLowerCase() === "next";
    if (!isNext) continue;
    try {
      const href = new URL(raw, base);
      href.hash = "";
      if (hostAllowed(href, base) && href.href !== base.href)
        return { value: href, truncated: truncationNotes(limits) };
    } catch {
      continue;
    }
  }
  return { value: null, truncated: truncationNotes(limits) };
}

/** Matched against one tag's source, never the page. */
const locationAttr = /(?:class|id|data-[a-z-]+)=["'][^"']*location[^"']*["']/i;
const descriptionAttr =
  /(?:class|id|data-[a-z-]+)=["'][^"']*description[^"']*["']/i;

/** Text of the first `<h1>`, or "". */
function firstHeadingText(html: string, limits: ScanLimits): string {
  for (const tag of scanTags(html, 0, limits)) {
    if (tag.closing || tag.name !== "h1") continue;
    const close = firstClose(html, tag, limits);
    if (!close) return "";
    return htmlToText(html.slice(tag.contentStart, close.start));
  }
  return "";
}

/**
 * Text of the first element whose class/id/data-* names a location, up to the
 * next closing tag — the old pattern ended at a bare `<\/`, and a single
 * `indexOf` reproduces that without re-scanning.
 */
function locationText(html: string, limits: ScanLimits): string {
  for (const tag of scanTags(html, 0, limits)) {
    if (tag.closing) continue;
    if (!locationAttr.test(tag.source)) continue;
    const end = html.indexOf("</", tag.contentStart);
    if (end < 0) return "";
    return htmlToText(html.slice(tag.contentStart, end));
  }
  return "";
}

/**
 * JSON-LD first, because it is the site's own structured answer. The DOM
 * fallback searches for a dedicated description container (class/id/data-*
 * matching "description"), falls back to <main> or <article>, then strips
 * nav/header/footer before using the rest of the page.
 */
export interface Posting {
  title: string;
  location: string;
  description: string;
  postedAt: string | null;
}

export function extractPosting(
  html: string,
  url: URL,
): ExtractionResult<Posting | null> {
  void url;
  const limits = newLimits();
  const [structured] = extractJsonLdJobs(html);
  if (structured?.title.trim()) {
    // JSON-LD is the site's own structured answer and is read without any
    // tag scan of ours, so no cap of this module's was reached to report.
    return {
      value: {
        title: structured.title.trim(),
        location: jsonLdLocation(structured),
        description: htmlToText(structured.description ?? ""),
        postedAt: structured.datePosted ?? null,
      },
      truncated: [],
    };
  }
  const title = firstHeadingText(html, limits);
  // Still reported when there is no posting: "nothing readable here" and
  // "nothing readable in the part of the page we were willing to read" are
  // different answers, and the caller deserves the second one when it is
  // true.
  if (!title) return { value: null, truncated: truncationNotes(limits) };
  return {
    value: {
      title,
      location: locationText(html, limits),
      description: extractDescription(html, limits).slice(0, 20_000),
      postedAt: null,
    },
    truncated: truncationNotes(limits),
  };
}

/**
 * Find a description container with balanced nesting, handling cases like
 * <div class="description"><div>para 1</div><div>para 2</div></div>.
 * Returns the inner HTML of the container, or null if not found.
 *
 * The depth walk used to re-`exec` two `<tag[^>]*>` patterns from `pos` on
 * every iteration, which is the same n² shape as the anchor scan above
 * (measured 200 KB of `"<div"` → 16.90 s). `scanTags` visits each tag once.
 */
function findDescriptionContainer(
  html: string,
  limits: ScanLimits,
): string | null {
  let open: Tag | null = null;
  for (const tag of scanTags(html, 0, limits)) {
    if (tag.closing) continue;
    if (tag.name !== "div" && tag.name !== "section" && tag.name !== "article")
      continue;
    if (!descriptionAttr.test(tag.source)) continue;
    // A self-closing container has no contents to return.
    if (tag.selfClosing) return null;
    open = tag;
    break;
  }
  if (!open) return null;

  let depth = 1;
  for (const tag of scanTags(html, open.contentStart, limits)) {
    if (tag.name !== open.name) continue;
    if (tag.closing) {
      depth--;
      if (depth === 0) return html.slice(open.contentStart, tag.start);
    } else if (!tag.selfClosing) {
      depth++;
    }
  }
  return null;
}

/** Contents of the first `<main>` or `<article>`, or null. */
function mainContent(html: string, limits: ScanLimits): string | null {
  for (const tag of scanTags(html, 0, limits)) {
    if (tag.closing) continue;
    if (tag.name !== "main" && tag.name !== "article") continue;
    const close = firstClose(html, tag, limits);
    if (!close) return null;
    return html.slice(tag.contentStart, close.start);
  }
  return null;
}

const strippedElements = new Set(["nav", "header", "footer"]);

/**
 * Replaces each `<nav>`/`<header>`/`<footer>` element with a space. The old
 * `.replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")` chain was quadratic for the same
 * reason everything else here was (200 KB of `"<nav"` → 14.97 s); this makes
 * one pass and keeps the lazy, nesting-blind semantics the old chain had.
 */
function stripChrome(html: string, limits: ScanLimits): string {
  const parts: string[] = [];
  let copied = 0;
  let cursor = 0;
  for (;;) {
    let open: Tag | null = null;
    for (const tag of scanTags(html, cursor, limits)) {
      if (!tag.closing && strippedElements.has(tag.name)) {
        open = tag;
        break;
      }
    }
    if (!open) break;
    const close = firstClose(html, open, limits);
    if (!close) break;
    parts.push(html.slice(copied, open.start), " ");
    copied = close.contentStart;
    cursor = copied;
  }
  if (copied === 0) return html;
  parts.push(html.slice(copied));
  return parts.join("");
}

/**
 * Extract description, trying containers in order:
 * 1. A container whose class, id, or data-* attribute contains "description"
 * 2. The contents of <main> or <article>
 * 3. The whole page with nav, header, footer stripped
 */
function extractDescription(html: string, limits: ScanLimits): string {
  const descContainer = findDescriptionContainer(html, limits);
  if (descContainer) return htmlToText(descContainer);

  const main = mainContent(html, limits);
  if (main) return htmlToText(main);

  return htmlToText(stripChrome(html, limits));
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
