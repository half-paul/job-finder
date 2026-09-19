import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { robotsContentTypeRefusal } from "@jobfinder/discovery";
import {
  blockedResource,
  crawlerUserAgent,
  hostAllowed,
  insecureModeAllowed,
  looksLikeCaptcha,
  navigationChain,
  publicAddressAllowed,
  refuseNavigationChain,
  resolvesToPublicAddress,
  type NavigationRequest,
  type NavigationResponse,
} from "../../apps/crawler/src/policy";
import { tlsVerificationDisabled } from "../../apps/crawler/src/session";

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

  /**
   * These drive the enforcement path, not just the predicate. `context.route`
   * never sees a redirect hop — Chromium follows a 302 internally — so the
   * defence lives in `navigationChain` + `refuseNavigationChain`, and
   * `session.ts` is a thin call into exactly the logic exercised here.
   */
  describe("redirect chain enforcement", () => {
    /** Builds the `redirectedFrom()`-linked request list Playwright hands us. */
    const chainOf = (...hops: string[]): NavigationResponse => {
      let request: NavigationRequest | null = null;
      for (const href of hops) {
        const previous: NavigationRequest | null = request;
        request = { url: () => href, redirectedFrom: () => previous };
      }
      const last = request;
      if (!last) throw new Error("A chain needs at least one hop");
      return { request: () => last, url: () => hops[hops.length - 1] };
    };

    /** A stand-in resolver: anything not listed is treated as public. */
    const resolver =
      (privateHosts: string[]) =>
      (hostname: string): Promise<boolean> =>
        Promise.resolve(!privateHosts.includes(hostname));

    const allPublic = () => Promise.resolve(true);

    it("lists every hop the navigation touched, oldest first", () => {
      const response = chainOf(
        "https://acme.example/careers",
        "https://acme.example/jobs",
      );
      expect(navigationChain(response, "https://acme.example/jobs")).toEqual([
        "https://acme.example/careers",
        "https://acme.example/jobs",
        "https://acme.example/jobs",
        "https://acme.example/jobs",
      ]);
    });

    it("still checks the settled URL when there is no response object", () => {
      expect(navigationChain(null, "https://acme.example/jobs")).toEqual([
        "https://acme.example/jobs",
      ]);
    });

    it("refuses a redirect chain that ends at a private address", async () => {
      const response = chainOf(
        "https://acme.example/careers",
        "https://metadata.acme.example/latest",
      );
      const refusal = await refuseNavigationChain(
        navigationChain(response, "https://metadata.acme.example/latest"),
        origin,
        resolver(["metadata.acme.example"]),
      );
      expect(refusal).toEqual({
        url: "https://metadata.acme.example/latest",
        reason: "resolves to a non-public address",
      });
    });

    it("refuses a private hop in the middle of an otherwise fine chain", async () => {
      const response = chainOf(
        "https://acme.example/careers",
        "https://internal.acme.example/hop",
        "https://acme.example/jobs",
      );
      const refusal = await refuseNavigationChain(
        navigationChain(response, "https://acme.example/jobs"),
        origin,
        resolver(["internal.acme.example"]),
      );
      expect(refusal?.url).toBe("https://internal.acme.example/hop");
    });

    it("refuses a redirect off-host or off HTTPS even when the address is public", async () => {
      const offHost = await refuseNavigationChain(
        navigationChain(
          chainOf("https://acme.example/careers", "https://evil.example/x"),
          "https://evil.example/x",
        ),
        origin,
        allPublic,
      );
      expect(offHost?.url).toBe("https://evil.example/x");

      const plainHttp = await refuseNavigationChain(
        navigationChain(
          chainOf("https://acme.example/careers", "http://acme.example/jobs"),
          "http://acme.example/jobs",
        ),
        origin,
        allPublic,
      );
      expect(plainHttp?.url).toBe("http://acme.example/jobs");
    });

    it("refuses a URL the browser settled on that no redirect response reported", async () => {
      const refusal = await refuseNavigationChain(
        navigationChain(
          chainOf("https://acme.example/careers"),
          "https://internal.acme.example/",
        ),
        origin,
        resolver(["internal.acme.example"]),
      );
      expect(refusal?.url).toBe("https://internal.acme.example/");
    });

    it("allows a clean chain, including a hop onto a recognised ATS host", async () => {
      const refusal = await refuseNavigationChain(
        navigationChain(
          chainOf(
            "https://acme.example/careers",
            "https://boards.greenhouse.io/acme",
          ),
          "https://boards.greenhouse.io/acme",
        ),
        origin,
        allPublic,
      );
      expect(refusal).toBeNull();
    });

    it("resolves a real hostname and refuses one that points at loopback", async () => {
      // No network: `localhost` resolves from the hosts file, and an IP
      // literal short-circuits the resolver entirely.
      await expect(resolvesToPublicAddress("localhost")).resolves.toBe(false);
      await expect(resolvesToPublicAddress("169.254.169.254")).resolves.toBe(
        false,
      );
      await expect(resolvesToPublicAddress("93.184.216.34")).resolves.toBe(
        true,
      );
    });

    describe("CRAWLER_INSECURE_TEST_HOSTNAME", () => {
      const key = "CRAWLER_INSECURE_TEST_HOSTNAME";
      const original = process.env[key];
      afterEach(() => {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      });

      it("refuses a private hostname when unset, matching production", async () => {
        delete process.env[key];
        await expect(
          resolvesToPublicAddress("host.docker.internal"),
        ).resolves.toBe(false);
      });

      it("allows only the exact hostname it names", async () => {
        process.env[key] = "host.docker.internal";
        await expect(
          resolvesToPublicAddress("host.docker.internal"),
        ).resolves.toBe(true);
        // A different hostname resolving privately is unaffected — this is
        // not a general SSRF bypass.
        await expect(resolvesToPublicAddress("localhost")).resolves.toBe(false);
      });
    });
  });

  // Fix round 2, P2: pins both production gates directly, so a regression in
  // either `insecureTestHostnameAllowed` (policy.ts) or the TLS gate
  // (`tlsVerificationDisabled`, session.ts) fails a test instead of only
  // being caught by manual live injection, as it was in fix round 1.
  describe("production refuses both insecure gates outright (NODE_ENV allow-list)", () => {
    // Next.js's own global type augmentation declares `NODE_ENV` `readonly`
    // and narrows it to `'development' | 'production' | 'test'`, which is
    // right for application code but blocks a test from setting it at all.
    // This cast is local to this test file and does not affect the type any
    // other module sees `process.env.NODE_ENV` as.
    const env = process.env as { [key: string]: string | undefined };
    const nodeEnvKey = "NODE_ENV";
    const hostnameKey = "CRAWLER_INSECURE_TEST_HOSTNAME";
    const tlsKey = "CRAWLER_INSECURE_TLS";
    const original = {
      nodeEnv: env[nodeEnvKey],
      hostname: env[hostnameKey],
      tls: env[tlsKey],
    };
    // Vitest itself runs under NODE_ENV=test, so every test in this block
    // must restore it — leaking a NODE_ENV=production override into a later
    // test file would silently change behaviour there too.
    afterEach(() => {
      for (const [key, value] of Object.entries({
        [nodeEnvKey]: original.nodeEnv,
        [hostnameKey]: original.hostname,
        [tlsKey]: original.tls,
      })) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    });

    it("refuses the hostname gate under NODE_ENV=production, even with the var set", async () => {
      env[nodeEnvKey] = "production";
      env[hostnameKey] = "host.docker.internal";
      await expect(
        resolvesToPublicAddress("host.docker.internal"),
      ).resolves.toBe(false);
    });

    it("refuses the TLS gate under NODE_ENV=production, even with the var set", () => {
      env[nodeEnvKey] = "production";
      env[tlsKey] = "1";
      expect(tlsVerificationDisabled()).toBe(false);
    });

    it('refuses both gates on an unrecognised NODE_ENV value, not only the literal string "production" — an allow-list fails closed on a typo', () => {
      env[nodeEnvKey] = "Production";
      env[hostnameKey] = "host.docker.internal";
      env[tlsKey] = "1";
      expect(insecureModeAllowed()).toBe(false);
      expect(tlsVerificationDisabled()).toBe(false);
    });

    it("refuses both gates when NODE_ENV is unset, the posture apps/crawler/Dockerfile's own ENV NODE_ENV=production exists to avoid outside Compose", () => {
      delete env[nodeEnvKey];
      env[hostnameKey] = "host.docker.internal";
      env[tlsKey] = "1";
      expect(insecureModeAllowed()).toBe(false);
      expect(tlsVerificationDisabled()).toBe(false);
    });

    it("allows both gates once NODE_ENV is an explicit, known non-production value", async () => {
      env[nodeEnvKey] = "test";
      env[hostnameKey] = "host.docker.internal";
      env[tlsKey] = "1";
      await expect(
        resolvesToPublicAddress("host.docker.internal"),
      ).resolves.toBe(true);
      expect(tlsVerificationDisabled()).toBe(true);
    });
  });
});

describe("robots.txt content-type guard", () => {
  // One implementation, used by both fetchers. Two hand-written copies had
  // already drifted — `packages/discovery/src/transport.ts` required
  // `/^\s*text\/plain\s*(;|$)/i`, `apps/crawler/src/robots.ts` only
  // `/^\s*text\/plain\b/i`, which accepts `text/plain-html` — and both ran
  // under `if (contentType && ...)`, so a 200 with no Content-Type at all
  // reached `parseRobots` and became an empty, i.e. permissive, ruleset.
  it("accepts text/plain, with or without parameters", () => {
    expect(robotsContentTypeRefusal("text/plain")).toBeNull();
    expect(robotsContentTypeRefusal("text/plain; charset=utf-8")).toBeNull();
    expect(robotsContentTypeRefusal("  Text/Plain ;charset=UTF-8")).toBeNull();
  });

  it("refuses a type that merely starts with text/plain", () => {
    expect(robotsContentTypeRefusal("text/plain-html")).toMatch(
      /unexpected content type/i,
    );
    expect(robotsContentTypeRefusal("text/html; charset=utf-8")).toMatch(
      /unexpected content type/i,
    );
  });

  it("refuses a response that declares no content type at all", () => {
    for (const missing of [null, undefined, "", "   "])
      expect(robotsContentTypeRefusal(missing)).toMatch(
        /no Content-Type header/i,
      );
  });

  it("is the only content-type check either robots fetcher performs", () => {
    const sources = [
      "apps/crawler/src/robots.ts",
      "packages/discovery/src/transport.ts",
    ].map((path) =>
      readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
    );
    for (const source of sources) {
      expect(source).toContain("robotsContentTypeRefusal(");
      // No local copy of the pattern left behind to drift again. Both files
      // still send `Accept: text/plain`, which is why this looks for the
      // regex-escaped spelling a pattern literal would use, not the string.
      expect(source).not.toContain(String.raw`text\/plain`);
    }
  });
});
