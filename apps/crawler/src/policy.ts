import { registrableDomain, atsHostPattern } from "@jobfinder/discovery";

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
