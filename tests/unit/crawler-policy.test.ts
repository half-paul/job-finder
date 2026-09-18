import { describe, expect, it } from "vitest";
import {
  blockedResource,
  crawlerUserAgent,
  hostAllowed,
  looksLikeCaptcha,
} from "../../apps/crawler/src/policy";

describe("crawler policy", () => {
  const origin = new URL("https://acme.example/careers");

  it("allows the same registrable domain and recognised ATS hosts", () => {
    expect(hostAllowed(new URL("https://acme.example/jobs/1"), origin)).toBe(
      true,
    );
    expect(hostAllowed(new URL("https://careers.acme.example/x"), origin)).toBe(
      true,
    );
    expect(
      hostAllowed(new URL("https://boards.greenhouse.io/acme"), origin),
    ).toBe(true);
  });

  it("refuses third-party hosts and plain HTTP", () => {
    expect(hostAllowed(new URL("https://tracker.example/pixel"), origin)).toBe(
      false,
    );
    expect(hostAllowed(new URL("http://acme.example/jobs"), origin)).toBe(
      false,
    );
  });

  it("blocks resources a listing never needs", () => {
    expect(blockedResource("image")).toBe(true);
    expect(blockedResource("media")).toBe(true);
    expect(blockedResource("font")).toBe(true);
    expect(blockedResource("document")).toBe(false);
    expect(blockedResource("xhr")).toBe(false);
  });

  it("recognises a challenge page", () => {
    expect(looksLikeCaptcha('<div class="g-recaptcha"></div>')).toBe(true);
    expect(looksLikeCaptcha("<p>Please verify you are a human</p>")).toBe(true);
    expect(looksLikeCaptcha("<h1>Open roles</h1>")).toBe(false);
  });

  it("appends the product token without introducing a bot token", () => {
    const ua = crawlerUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0.0.0 Safari/537.36",
    );
    expect(ua).toContain("JobFinder/1.0");
    expect(ua).not.toMatch(/headless/i);
    expect(ua).not.toMatch(/\bbot\b|crawler|spider|curl/i);
  });
});
