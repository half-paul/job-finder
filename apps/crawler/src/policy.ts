import { isIP } from "node:net";
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
    const records = await lookup(hostname, { all: true });
    return (
      records.length > 0 &&
      records.every((record) => publicAddressAllowed(record.address))
    );
  } catch {
    return false;
  }
}
