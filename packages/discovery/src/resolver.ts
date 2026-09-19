import {
  extractJsonLdJobs,
  type CrawlerClient,
  type TransportOptions,
} from "@jobfinder/job-sources";
import {
  isSupportedAts,
  type CrawlPatternSpec,
  type PolicyCheck,
  type SupportedAts,
} from "@jobfinder/shared";
import { detectAts } from "./ats";
import { findCareersPage, scoreCareersLinks } from "./careers";
import { buildPatternSpec, validatePattern } from "./patterns";
import { RobotsBlockedError } from "./robots";
import { registrableDomain } from "./seed-list";
import {
  discoveryFetch,
  RobotsCache,
  type DiscoveryFetchResult,
} from "./transport";

// Never adopt an auth or application endpoint as the resolved careers page:
// it is worse than the marketing page it would replace (nothing to read,
// and it is not where the captured-API/browser rungs should point).
const authPathSegment = /^(login|signin|sign-in|register|apply|logout)$/i;
const isAuthPath = (pathname: string) =>
  pathname.split("/").some((segment) => authPathSegment.test(segment));

// The one vendor-specific rewrite in this walk: Workday's login path is
// predictably its board root plus `/login` (`/en-US/{site}/login` ->
// `/en-US/{site}`). This is narrow and cheaply verified (the caller still
// fetches the result and requires HTTP 200 before adopting it), unlike
// guessing at URL shapes for vendors we have not confirmed this pattern for.
const workdayLoginPath = /^(\/[a-z]{2}-[a-z]{2}\/[^/]+)\/login\/?$/i;
function workdayBoardRoot(url: URL): URL | null {
  if (!/\.myworkdayjobs\.com$/i.test(url.hostname)) return null;
  const match = workdayLoginPath.exec(url.pathname);
  return match ? new URL(match[1], url) : null;
}

/**
 * Whether a bare candidate URL (no page content to inspect yet) belongs to
 * the same ATS vendor we already detected. Scopes the hub walk to that
 * vendor's host: a link to a *different* company's board -- even on a
 * supported ATS, even one our own page links to as a partner -- is not
 * evidence about this company and must never be followed or adopted.
 */
const isSameVendorHost = (url: URL, wanted: string) =>
  detectAts({ finalUrl: url, chain: [], html: "" })?.ats === wanted;

export interface DiscoveryOptions extends TransportOptions {
  onProgress?: (stage: string, message: string) => Promise<void>;
  /** Null means the browser rung is unavailable; the resolver says so. */
  crawlerClient?: CrawlerClient | null;
  /** Injected in tests so pattern validation does not need a live replay. */
  validateSpec?: typeof validatePattern;
}
export interface Resolution {
  careersUrl: string;
  provider: SupportedAts | "Careers" | "CapturedApi" | "Browser";
  board: string;
  strategy: "ats" | "json-ld" | "captured-api" | "browser" | "ai";
  ats: string | null;
  policy: PolicyCheck;
  /** Present only for `captured-api`; the caller persists it. */
  pattern?: CrawlPatternSpec;
}

export async function resolveCompanyWebsite(
  websiteUrl: string,
  options: DiscoveryOptions = {},
): Promise<Resolution> {
  const robots = new RobotsCache(options);
  const fetchOptions = { ...options, robots };
  const input = new URL(websiteUrl);
  await options.onProgress?.(
    "discovery",
    "Finding the careers section and checking for supported job APIs.",
  );
  const home = await discoveryFetch(input, fetchOptions);
  if (home.status !== 200)
    throw new Error(`Company website returned HTTP ${home.status}.`);
  let page: DiscoveryFetchResult = home;
  let detection = detectAts({
    finalUrl: home.finalUrl,
    chain: home.chain,
    html: home.text,
  });
  if (
    !detection &&
    !extractJsonLdJobs(home.text).length &&
    !/career|jobs|vacanc|employment/i.test(input.pathname)
  ) {
    const domain = registrableDomain(home.finalUrl.hostname)!;
    const links = scoreCareersLinks(home.text, home.finalUrl, domain);
    if (links.length) {
      page = await discoveryFetch(links[0].url, fetchOptions);
      if (page.status !== 200)
        throw new Error(`Careers page returned HTTP ${page.status}.`);
    } else {
      // Keep homepage evidence for AI navigation if conventional paths cannot be found.
      page = (await findCareersPage(domain, fetchOptions)) ?? home;
    }
    detection = detectAts({
      finalUrl: page.finalUrl,
      chain: page.chain,
      html: page.text,
    });
  }
  // Careers hubs may link to department pages before exposing their ATS.
  // Inspect at most three observed destinations before selecting AI fallback.
  // A *supported* detection already returns early below, so this only runs
  // for the unsupported and undetected cases -- and an unsupported detection
  // (e.g. Workday mentioned in a login link) is exactly when we know the
  // most useful thing: which ATS host to walk toward.
  const unsupportedDetection =
    detection && !isSupportedAts(detection.ats) ? detection : null;
  if (
    (!detection || unsupportedDetection) &&
    !extractJsonLdJobs(page.text).length
  ) {
    const visited = new Set([
      input.href,
      ...home.chain,
      home.finalUrl.href,
      ...page.chain,
      page.finalUrl.href,
    ]);
    const domain = registrableDomain(page.finalUrl.hostname)!;
    if (unsupportedDetection) {
      // We already know which ATS to look for, so only follow links that
      // resolve to THAT vendor's host (see `isSameVendorHost`). This is what
      // keeps a partner's or rival's board -- linked from the same hub, even
      // on a supported ATS -- from ever becoming a candidate at all.
      const candidates = scoreCareersLinks(page.text, page.finalUrl, domain)
        .filter((link) => !visited.has(link.url.href))
        .filter((link) => isSameVendorHost(link.url, unsupportedDetection.ats))
        .slice(0, 3);
      for (const link of candidates) {
        // The candidate's own path, not the eventual redirect target: do
        // not even fetch a link that presents itself as a login form,
        // except Workday's narrow, verified rewrite to its board root.
        let target = link.url;
        if (isAuthPath(link.url.pathname)) {
          const root = workdayBoardRoot(link.url);
          if (!root) continue;
          target = root;
        }
        if (visited.has(target.href)) continue;
        let linked: DiscoveryFetchResult;
        try {
          linked = await discoveryFetch(target, fetchOptions);
        } catch (error) {
          // A candidate we are merely exploring should not sink the whole
          // resolution the way a block on the company's own page would;
          // just move on to the next one.
          if (error instanceof RobotsBlockedError) continue;
          throw error;
        }
        if (linked.status !== 200) continue;
        const linkedDetection = detectAts({
          finalUrl: linked.finalUrl,
          chain: linked.chain,
          html: linked.text,
        });
        // Every candidate here already matches the detected (unsupported)
        // vendor, so this can never turn out to be a *supported* ATS: the
        // first reachable page on that vendor's host is the best available.
        page = linked;
        detection = linkedDetection ?? detection;
        break;
      }
    } else {
      // Nothing detected at all: unchanged from before this fix.
      const links = scoreCareersLinks(page.text, page.finalUrl, domain)
        .filter((link) => !visited.has(link.url.href))
        .slice(0, 3);
      for (const link of links) {
        const linked = await discoveryFetch(link.url, fetchOptions);
        if (linked.status !== 200) continue;
        const linkedDetection = detectAts({
          finalUrl: linked.finalUrl,
          chain: linked.chain,
          html: linked.text,
        });
        if (linkedDetection && isSupportedAts(linkedDetection.ats)) {
          page = linked;
          detection = linkedDetection;
          break;
        }
      }
    }
  }
  const policy = await robots.assertAllowed(page.finalUrl);
  if (detection && isSupportedAts(detection.ats)) {
    await options.onProgress?.(
      "api",
      `${detection.ats} API detected; board ${detection.key}.`,
    );
    return {
      careersUrl: page.finalUrl.href,
      provider: detection.ats,
      board: detection.key,
      strategy: "ats",
      ats: detection.ats,
      policy,
    };
  }
  const structured = extractJsonLdJobs(page.text).length > 0;
  if (structured) {
    await options.onProgress?.(
      "strategy",
      "Structured job listings found. Reading those before using AI.",
    );
    return {
      careersUrl: page.finalUrl.href,
      provider: "Careers",
      board: input.hostname,
      strategy: "json-ld",
      ats: detection?.ats ?? null,
      policy,
    };
  }

  const detected = detection
    ? `${detection.ats} detected without a supported API connector. `
    : "No supported job API detected. ";
  const crawler = options.crawlerClient;
  if (!crawler) {
    await options.onProgress?.(
      "strategy",
      `${detected}The crawler service is not configured, so the cheaper captured-API and browser rungs were skipped. Using careers-page extraction with an AI fallback.`,
    );
    return {
      careersUrl: page.finalUrl.href,
      provider: "Careers",
      board: input.hostname,
      strategy: "ai",
      ats: detection?.ats ?? null,
      policy,
    };
  }

  const validate = options.validateSpec ?? validatePattern;
  try {
    await options.onProgress?.(
      "capture",
      "Watching the careers page for a job API it calls.",
    );
    const captured = await crawler.capture(
      { url: page.finalUrl.href },
      options.signal,
    );
    for (const candidate of captured.patterns) {
      const spec = buildPatternSpec(candidate);
      if (!spec) continue;
      const verdict = await validate(spec, options);
      if (!verdict.ok) continue;
      await options.onProgress?.(
        "strategy",
        `Saved the job API this page calls; ${verdict.count} postings replayed without a browser.`,
      );
      return {
        careersUrl: page.finalUrl.href,
        provider: "CapturedApi",
        board: input.hostname,
        strategy: "captured-api",
        ats: detection?.ats ?? null,
        policy,
        pattern: spec,
      };
    }
    await options.onProgress?.(
      "strategy",
      `${detected}No replayable job API was found, so this board will be read with a browser.`,
    );
    return {
      careersUrl: page.finalUrl.href,
      provider: "Browser",
      board: input.hostname,
      strategy: "browser",
      ats: detection?.ats ?? null,
      policy,
    };
  } catch (error) {
    // An unreachable or failing crawler must not cost a company its
    // resolution: the AI rung already handles this page today.
    await options.onProgress?.(
      "strategy",
      `${detected}The crawler service could not read this page (${
        error instanceof Error ? error.message : "unknown error"
      }), so it falls back to careers-page extraction with AI.`,
    );
    return {
      careersUrl: page.finalUrl.href,
      provider: "Careers",
      board: input.hostname,
      strategy: "ai",
      ats: detection?.ats ?? null,
      policy,
    };
  }
}
