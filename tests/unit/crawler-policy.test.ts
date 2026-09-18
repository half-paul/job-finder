import { describe, expect, it } from "vitest";
import {
  blockedResource,
  crawlerUserAgent,
  hostAllowed,
  looksLikeCaptcha,
  publicAddressAllowed,
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

  describe("publicAddressAllowed", () => {
    it("allows ordinary public IPv4 and IPv6 addresses", () => {
      expect(publicAddressAllowed("93.184.216.34")).toBe(true);
      expect(publicAddressAllowed("8.8.8.8")).toBe(true);
      expect(publicAddressAllowed("2606:4700:4700::1111")).toBe(true);
    });

    it("refuses every IPv4 SSRF-relevant range", () => {
      expect(publicAddressAllowed("127.0.0.1")).toBe(false); // loopback
      expect(publicAddressAllowed("10.0.0.1")).toBe(false); // private 10/8
      expect(publicAddressAllowed("172.16.0.1")).toBe(false); // private 172.16/12
      expect(publicAddressAllowed("172.31.255.255")).toBe(false); // private 172.16/12
      expect(publicAddressAllowed("192.168.1.1")).toBe(false); // private 192.168/16
      expect(publicAddressAllowed("169.254.169.254")).toBe(false); // link-local / cloud metadata
      expect(publicAddressAllowed("100.64.0.1")).toBe(false); // CGNAT 100.64/10
      expect(publicAddressAllowed("100.127.255.255")).toBe(false); // CGNAT 100.64/10
      expect(publicAddressAllowed("255.255.255.255")).toBe(false); // broadcast
      expect(publicAddressAllowed("0.0.0.0")).toBe(false); // unspecified
    });

    it("refuses every IPv6 SSRF-relevant range, including IPv4-mapped forms", () => {
      expect(publicAddressAllowed("::1")).toBe(false); // loopback
      expect(publicAddressAllowed("::")).toBe(false); // unspecified
      expect(publicAddressAllowed("fc00::1")).toBe(false); // unique-local fc00::/7
      expect(publicAddressAllowed("fd12:3456:789a::1")).toBe(false); // unique-local fc00::/7
      expect(publicAddressAllowed("fe80::1")).toBe(false); // link-local fe80::/10
      // IPv4-mapped forms of addresses that must never be reachable.
      expect(publicAddressAllowed("::ffff:169.254.169.254")).toBe(false);
      expect(publicAddressAllowed("::ffff:127.0.0.1")).toBe(false);
      expect(publicAddressAllowed("::ffff:10.0.0.1")).toBe(false);
    });
  });
});
