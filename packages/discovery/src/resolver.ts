import {
  extractJsonLdJobs,
  type TransportOptions,
} from "@jobfinder/job-sources";
import { isSupportedAts, type PolicyCheck } from "@jobfinder/shared";
import { detectAts } from "./ats";
import { findCareersPage, scoreCareersLinks } from "./careers";
import { registrableDomain } from "./seed-list";
import {
  discoveryFetch,
  RobotsCache,
  type DiscoveryFetchResult,
} from "./transport";

export interface DiscoveryOptions extends TransportOptions {
  onProgress?: (stage: string, message: string) => Promise<void>;
}
export interface Resolution {
  careersUrl: string;
  provider: "Greenhouse" | "Lever" | "Ashby" | "Careers";
  board: string;
  strategy: "ats" | "json-ld" | "ai";
  ats: string | null;
  policy: PolicyCheck;
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
  if (!detection && !extractJsonLdJobs(page.text).length) {
    const visited = new Set([
      input.href,
      ...home.chain,
      home.finalUrl.href,
      ...page.chain,
      page.finalUrl.href,
    ]);
    const links = scoreCareersLinks(
      page.text,
      page.finalUrl,
      registrableDomain(page.finalUrl.hostname)!,
    )
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
  await options.onProgress?.(
    "strategy",
    structured
      ? "Structured job listings found. Reading those before using AI."
      : `${detection ? `${detection.ats} detected without a supported API connector. ` : "No supported job API detected. "}Using careers-page extraction with an AI fallback.`,
  );
  return {
    careersUrl: page.finalUrl.href,
    provider: "Careers",
    board: input.hostname,
    strategy: structured ? "json-ld" : "ai",
    ats: detection?.ats ?? null,
    policy,
  };
}
