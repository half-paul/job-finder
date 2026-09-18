import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { registrableDomain, atsHostPattern } from "@jobfinder/discovery";
import { isPublicAddress } from "@jobfinder/job-sources";

/**
 * A crawl may follow links within the company's own registrable domain and on
 * to a recognised ATS, and nowhere else. Anything third-party is an advert, a
 * tracker or another company's board.
 */
export function hostAllowed(target: URL, origin: URL): boolean {
  if (target.protocol !== "https:") return false;
  const domain = registrableDomain(origin.hostname);
  if (!domain) return false;
  return (
    registrableDomain(target.hostname) === domain ||
    atsHostPattern.test(target.hostname)
  );
}

const blockedTypes = new Set(["image", "media", "font", "stylesheet"]);

/** A job listing is text. Everything else is bandwidth and fingerprinting. */
export function blockedResource(type: string): boolean {
  return blockedTypes.has(type);
}

const captchaMarkers = [
  /g-recaptcha/i,
  /hcaptcha/i,
  /cf-challenge/i,
  /turnstile/i,
  /verify you are (a )?human/i,
  /are you a robot/i,
  /enable javascript and cookies to continue/i,
];

/**
 * A challenge page ends the session with `kind: "captcha"` and no retry. We do
 * not solve challenges; a site presenting one has declined automated access.
 */
export function looksLikeCaptcha(html: string): boolean {
  return captchaMarkers.some((marker) => marker.test(html));
}

/**
 * Chromium's own user agent with our product token appended. `HeadlessChrome`
 * is rewritten to `Chrome` because edges reject the headless token on sight,
 * and no `bot`-shaped token is introduced: Akamai Bot Manager resets the
 * connection for those before responding, turning a refusal into a hang.
 */
export function crawlerUserAgent(chromeUserAgent: string): string {
  return `${chromeUserAgent.replace(/HeadlessChrome/g, "Chrome")} JobFinder/1.0`;
}

/**
 * Reuses the worker's own public-address predicate (`@jobfinder/job-sources`,
 * shared with `packages/discovery`'s connector transport) rather than
 * re-deriving the range list, so the two paths cannot disagree on what
 * "public" means. It already rejects: IPv4 loopback, private (10/8,
 * 172.16/12, 192.168/16), CGNAT (100.64/10), link-local (169.254/16),
 * broadcast/multicast/reserved (>=224), and unspecified (0.0.0.0); and,
 * for IPv6, everything outside the 2000::/3 global-unicast range —
 * which is a strict allowlist, so loopback (::1), unspecified (::),
 * unique-local (fc00::/7), link-local (fe80::/10), and any IPv4-mapped
 * form (`::ffff:a.b.c.d`, which never starts with `2` or `3`) are all
 * rejected as a consequence, not as special cases.
 */
export function publicAddressAllowed(address: string): boolean {
  return isPublicAddress(address);
}

/**
 * Resolves a hostname (or passes through an already-literal IP) and checks
 * every returned address against `publicAddressAllowed`. A single private
 * address among several is enough to refuse: an attacker only needs one
 * resolver response to point at an internal service. A hostname that fails
 * to resolve at all is treated as not-public — there is nothing to allow.
 */
export async function resolvesToPublicAddress(
  hostname: string,
): Promise<boolean> {
  if (isIP(hostname)) return publicAddressAllowed(hostname);
  try {
    const records = await lookupWithin(hostname, dnsTimeoutMs);
    return (
      records.length > 0 &&
      records.every((record) => publicAddressAllowed(record.address))
    );
  } catch {
    return false;
  }
}

/** A resolver that never answers must not be able to stall us indefinitely. */
const dnsTimeoutMs = 3_000;

/**
 * `dns.lookup` is bounded only by the operating system's resolver, and each
 * in-flight call occupies one of libuv's four default threadpool slots for
 * its whole duration. A hostile or merely broken resolver could therefore
 * hold every navigation — and unrelated threadpool work elsewhere in the
 * process — hostage. This races the lookup against a timer so the caller is
 * released on time.
 *
 * The rejection is deliberate rather than a `false` return: it lands in
 * `resolvesToPublicAddress`'s existing `catch`, which fails closed, so a
 * lookup we could not finish is treated exactly like one that came back
 * private. Node offers no way to cancel an in-flight `lookup`, so the
 * abandoned call still occupies its slot until the OS gives up; what this
 * bounds is how long *we* wait on it, which is what starves navigations.
 */
async function lookupWithin(
  hostname: string,
  ms: number,
): Promise<LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup for ${hostname} timed out`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A hostname and address check applied to one URL. Both the browser session's
 * redirect-chain validation and the robots.txt fetch call this, so there is
 * exactly one definition of "a hop we are willing to follow" and the two
 * paths cannot drift.
 *
 * `isPublic` is injected rather than called directly so the caller can supply
 * its per-session memoised resolver — and so the logic is testable without a
 * network or a browser.
 */
export interface HopRefusal {
  /** The URL that was refused, for the plain-language failure message. */
  url: string;
  /** Why, in plain language, without a trailing full stop. */
  reason: string;
}

export async function refuseHop(
  href: string,
  origin: URL,
  isPublic: (hostname: string) => Promise<boolean>,
): Promise<HopRefusal | null> {
  let target: URL;
  try {
    target = new URL(href);
  } catch {
    return { url: href, reason: "is not a usable URL" };
  }
  if (!hostAllowed(target, origin))
    return {
      url: href,
      reason: `is not HTTPS on ${origin.hostname}'s own domain or a recognised ATS host`,
    };
  if (!(await isPublic(target.hostname)))
    return { url: href, reason: "resolves to a non-public address" };
  return null;
}

/**
 * Validates every URL a navigation touched — the URL we asked for, each
 * redirect hop, and the URL the page actually settled on — and returns the
 * first one we refuse, or `null` when the whole chain is acceptable.
 *
 * This exists because `context.route` does not see redirect hops: with
 * `route.continue()` a 302 produces exactly one route event, for the initial
 * URL, and Chromium then follows the redirect internally. A careers page that
 * redirects to `http://169.254.169.254/` would otherwise be fetched and its
 * body handed back to the caller. Every hop must pass the same checks the
 * initial request did, and the HTML must not be read until they all have.
 *
 * Duplicate hrefs are checked once: a chain commonly repeats its final URL
 * (the response's URL and the page's settled URL are the same string), and
 * re-checking costs a map lookup for no extra safety.
 */
export async function refuseNavigationChain(
  chain: readonly string[],
  origin: URL,
  isPublic: (hostname: string) => Promise<boolean>,
): Promise<HopRefusal | null> {
  const checked = new Set<string>();
  for (const href of chain) {
    if (checked.has(href)) continue;
    checked.add(href);
    const refusal = await refuseHop(href, origin, isPublic);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * The slice of Playwright's `Request`/`Response` that `navigationChain` needs.
 * Declared structurally so this module — and the tests for it — stay free of
 * a Playwright import; the real objects satisfy these shapes as they are.
 */
export interface NavigationRequest {
  url(): string;
  redirectedFrom(): NavigationRequest | null;
}

export interface NavigationResponse {
  request(): NavigationRequest;
  url(): string;
}

/**
 * Every URL a navigation touched, oldest hop first: the request we issued,
 * each redirect Chromium followed on its own, the URL the response came from,
 * and the URL the page settled on (which also catches a `<meta refresh>` or a
 * script-driven `location` change that produced no redirect response at all).
 *
 * `redirectedFrom()` walks backwards one hop at a time, so the list is built
 * by unshifting. Duplicates are expected and harmless — the validator checks
 * each distinct href once.
 */
export function navigationChain(
  response: NavigationResponse | null,
  settledUrl: string,
): string[] {
  const chain: string[] = [];
  if (response) {
    let request: NavigationRequest | null = response.request();
    while (request) {
      chain.unshift(request.url());
      request = request.redirectedFrom();
    }
    chain.push(response.url());
  }
  chain.push(settledUrl);
  return chain;
}
