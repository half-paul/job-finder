import { describe, expect, it } from "vitest";
import {
  candidateStatuses,
  candidateStatusLabel,
  companyImportSchema,
  crawlPatternSpecSchema,
  crawlResponseSchema,
  crawlStrategies,
  jsonPointerGet,
  strategyLabel,
} from "@jobfinder/shared";

describe("Phase 5 shared discovery contracts", () => {
  it("labels every candidate status in plain language", () => {
    expect(candidateStatusLabel.Pending).toBe("Waiting for worker");
    expect(candidateStatusLabel.Blocked).toBe("Robots.txt disallows crawling");
    expect(candidateStatusLabel.Unsupported).toBe(
      "Vendor recognised, not yet supported",
    );
  });

  it("has a plain-language label for every candidate status and crawl strategy", () => {
    for (const status of candidateStatuses)
      expect(candidateStatusLabel[status]).toEqual(expect.any(String));
    expect(candidateStatusLabel.Resolving).toBe("Looking for careers page");
    expect(candidateStatusLabel.Resolved).toBe("Resolved");
    expect(candidateStatusLabel.NoCareersPage).toBe("No careers page found");
    expect(candidateStatusLabel.Failed).toBe("Failed");
    for (const strategy of crawlStrategies)
      expect(strategyLabel[strategy]).toEqual(expect.any(String));
    expect(strategyLabel.none).toBe("Not resolved");
    expect(strategyLabel.ats).toBe("Scanning ATS board");
    expect(strategyLabel["captured-api"]).toBe("Replaying saved API");
    expect(strategyLabel.browser).toBe("Browser crawl");
  });

  it("bounds the import body", () => {
    expect(companyImportSchema.parse({ text: "acme.com" })).toEqual({
      text: "acme.com",
    });
    expect(
      companyImportSchema.safeParse({ text: "x".repeat(200_001) }).success,
    ).toBe(false);
  });

  it("reads JSON pointers including escaped segments", () => {
    const value = { data: { "a/b": [{ title: "One" }] } };
    expect(jsonPointerGet(value, "/data/a~1b/0/title")).toBe("One");
    expect(jsonPointerGet(value, "")).toBe(value);
    expect(jsonPointerGet(value, "/missing/x")).toBeUndefined();
  });

  it("rejects crawler responses that exceed caps or use plain HTTP", () => {
    expect(
      crawlResponseSchema.safeParse({
        jobs: [{ title: "Engineer", url: "http://example.com/j/1" }],
        complete: true,
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      crawlPatternSpecSchema.safeParse({
        urlTemplate: "https://example.com/api/jobs?page={page}",
        method: "GET",
        headers: { accept: "application/json" },
        body: null,
        jobsPath: "/jobs",
        fieldMap: { title: "/title", url: "/url" },
      }).success,
    ).toBe(true);
  });
});

import {
  parseRobots,
  parseSeedList,
  registrableDomain,
  robotsAllows,
} from "@jobfinder/discovery";

describe("Phase 5 seed list parser", () => {
  it("reduces hosts to registrable domains with common two-level suffixes", () => {
    expect(registrableDomain("www.acme.com")).toBe("acme.com");
    expect(registrableDomain("jobs.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("ACME.COM.")).toBe("acme.com");
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("10.0.0.1")).toBeNull();
  });

  it("accepts pasted lines, URLs and CSV with a header", () => {
    const parsed = parseSeedList(
      [
        "Acme, acme.com",
        "https://www.beta.io/about?x=1",
        "gamma.co.uk",
        "",
        "not a domain",
      ].join("\n"),
    );
    expect(parsed.rows).toEqual([
      { name: "Acme", domain: "acme.com" },
      {
        name: "beta.io",
        domain: "beta.io",
        websiteUrl: "https://www.beta.io/about?x=1",
      },
      { name: "gamma.co.uk", domain: "gamma.co.uk" },
    ]);
    expect(parsed.rejected).toEqual([{ line: 5, reason: "No domain found" }]);
    const csv = parseSeedList(
      'company,website\nDelta Corp,https://delta.example\n"Epsilon, Inc",epsilon.example\n',
    );
    expect(csv.rows).toEqual([
      { name: "Delta Corp", domain: "delta.example" },
      { name: "Epsilon, Inc", domain: "epsilon.example" },
    ]);
  });

  it("dedupes within one import and caps at 500 rows", () => {
    const parsed = parseSeedList(
      Array.from({ length: 502 }, (_, i) => `c${i}.example`).join("\n") +
        "\nc1.example",
    );
    expect(parsed.rows).toHaveLength(500);
    expect(
      parsed.rejected.some((r) => r.reason === "Import limit is 500 rows"),
    ).toBe(true);
    expect(parsed.rejected.some((r) => r.reason === "Duplicate domain")).toBe(
      true,
    );
  });

  it("rejects a name or domain longer than the field limit", () => {
    const parsed = parseSeedList(`${"a".repeat(201)},acme.example`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rejected).toEqual([
      { line: 1, reason: "Company name or domain is too long" },
    ]);
  });
});

describe("Phase 5 robots parser", () => {
  const rules = parseRobots(`
User-agent: *
Disallow: /private/
Allow: /private/open

User-agent: JobFinderBot
Disallow: /careers/internal
`);
  it("applies the most specific agent group", () => {
    expect(robotsAllows(rules, "/careers", "JobFinderBot")).toEqual({
      allowed: true,
    });
    expect(robotsAllows(rules, "/careers/internal/x", "JobFinderBot")).toEqual({
      allowed: false,
      matchedRule: "Disallow: /careers/internal",
    });
    // The JobFinderBot group replaces the wildcard group entirely.
    expect(robotsAllows(rules, "/private/x", "JobFinderBot").allowed).toBe(
      true,
    );
  });
  it("prefers the longest matching rule for the wildcard agent", () => {
    expect(robotsAllows(rules, "/private/x", "OtherBot").allowed).toBe(false);
    expect(robotsAllows(rules, "/private/open/1", "OtherBot").allowed).toBe(
      true,
    );
  });
  it("treats an empty or missing file as allow-all", () => {
    expect(robotsAllows(parseRobots(""), "/anything", "JobFinderBot")).toEqual({
      allowed: true,
    });
  });

  it("matches wildcard segments and an end anchor like Google's robots parser", () => {
    const wildcard = parseRobots(
      "User-agent: *\nDisallow: /*.pdf$\nDisallow: /files/*/private",
    );
    expect(robotsAllows(wildcard, "/reports/q1.pdf", "Bot")).toEqual({
      allowed: false,
      matchedRule: "Disallow: /*.pdf$",
    });
    expect(robotsAllows(wildcard, "/reports/q1.pdf.bak", "Bot").allowed).toBe(
      true,
    );
    expect(robotsAllows(wildcard, "/files/team-a/private", "Bot").allowed).toBe(
      false,
    );
  });
});

import {
  RobotsBlockedError,
  RobotsCache,
  discoveryFetch,
  discoveryUserAgent,
} from "@jobfinder/discovery";

/** Routes by URL string; unknown URLs return 404. */
const routeFetch = (routes: Record<string, () => Response>) =>
  (async (input: RequestInfo | URL) => {
    const key = String(input instanceof Request ? input.url : input);
    return routes[key]?.() ?? new Response("missing", { status: 404 });
  }) as typeof fetch;

const publicHost = async () => [{ address: "93.184.216.34", family: 4 }];

describe("Phase 5 discovery transport", () => {
  it("follows up to three public HTTPS redirects and records the chain", async () => {
    const fetchImpl = routeFetch({
      "https://acme.example/": () =>
        new Response(null, { status: 301, headers: { location: "/home" } }),
      "https://acme.example/home": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://www.acme.example/" },
        }),
      "https://www.acme.example/": () =>
        new Response("<title>Acme</title>", {
          headers: { "content-type": "text/html" },
        }),
      "https://acme.example/robots.txt": () =>
        new Response("", { status: 404 }),
      "https://www.acme.example/robots.txt": () =>
        new Response("", { status: 404 }),
    });
    const robots = new RobotsCache({ fetchImpl, resolveHost: publicHost });
    const result = await discoveryFetch(new URL("https://acme.example/"), {
      fetchImpl,
      resolveHost: publicHost,
      robots,
    });
    expect(result.finalUrl.href).toBe("https://www.acme.example/");
    expect(result.chain).toEqual([
      "https://acme.example/",
      "https://acme.example/home",
      "https://www.acme.example/",
    ]);
    expect(result.status).toBe(200);
    expect(result.text).toContain("Acme");
  });

  it("stops at the fourth redirect and refuses plain-HTTP hops", async () => {
    const loop = routeFetch({
      "https://a.example/": () =>
        new Response(null, { status: 302, headers: { location: "/1" } }),
      "https://a.example/1": () =>
        new Response(null, { status: 302, headers: { location: "/2" } }),
      "https://a.example/2": () =>
        new Response(null, { status: 302, headers: { location: "/3" } }),
      "https://a.example/3": () =>
        new Response(null, { status: 302, headers: { location: "/4" } }),
      "https://a.example/robots.txt": () => new Response("", { status: 404 }),
    });
    const robots = new RobotsCache({
      fetchImpl: loop,
      resolveHost: publicHost,
    });
    await expect(
      discoveryFetch(new URL("https://a.example/"), {
        fetchImpl: loop,
        resolveHost: publicHost,
        robots,
      }),
    ).rejects.toThrow("Too many redirects");
    const insecure = routeFetch({
      "https://b.example/": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://b.example/x" },
        }),
      "https://b.example/robots.txt": () => new Response("", { status: 404 }),
    });
    await expect(
      discoveryFetch(new URL("https://b.example/"), {
        fetchImpl: insecure,
        resolveHost: publicHost,
        robots: new RobotsCache({
          fetchImpl: insecure,
          resolveHost: publicHost,
        }),
      }),
    ).rejects.toThrow(/HTTPS/);
  });

  it("fetches robots.txt once per host and blocks disallowed paths", async () => {
    let robotsCalls = 0;
    const fetchImpl = routeFetch({
      "https://c.example/robots.txt": () => {
        robotsCalls++;
        return new Response("User-agent: *\nDisallow: /careers\n");
      },
      "https://c.example/about": () => new Response("<p>ok</p>"),
    });
    const robots = new RobotsCache({ fetchImpl, resolveHost: publicHost });
    const about = await discoveryFetch(new URL("https://c.example/about"), {
      fetchImpl,
      resolveHost: publicHost,
      robots,
    });
    expect(about.status).toBe(200);
    const blocked = discoveryFetch(new URL("https://c.example/careers"), {
      fetchImpl,
      resolveHost: publicHost,
      robots,
    });
    await expect(blocked).rejects.toBeInstanceOf(RobotsBlockedError);
    expect(robotsCalls).toBe(1);
    const check = await robots.check(new URL("https://c.example/careers/x"));
    expect(check).toMatchObject({
      robotsAllowed: false,
      robotsUrl: "https://c.example/robots.txt",
      userAgent: "JobFinder/1.0",
      matchedRule: "Disallow: /careers",
    });
  });

  it("treats a 401/403 on robots.txt itself as a block, not as allow-all", async () => {
    const fetchImpl = routeFetch({
      "https://d.example/robots.txt": () =>
        new Response("Forbidden", { status: 403 }),
    });
    const robots = new RobotsCache({ fetchImpl, resolveHost: publicHost });
    await expect(
      discoveryFetch(new URL("https://d.example/"), {
        fetchImpl,
        resolveHost: publicHost,
        robots,
      }),
    ).rejects.toBeInstanceOf(RobotsBlockedError);
  });
});

import {
  careersProbePaths,
  findCareersPage,
  scoreCareersLinks,
} from "@jobfinder/discovery";

describe("Phase 5 careers URL finder", () => {
  it("scores anchor text and path and keeps only same-domain or ATS links", () => {
    const html = `
      <a href="/about">About</a>
      <a href="/company/careers">Join our team</a>
      <a href="https://boards.greenhouse.io/acme">Open positions</a>
      <a href="https://evil.example/careers">Careers</a>
      <a href="/blog/jobs-report">Jobs report</a>`;
    const scored = scoreCareersLinks(
      html,
      new URL("https://acme.example/"),
      "acme.example",
    );
    expect(scored[0].url.href).toBe("https://acme.example/company/careers");
    expect(scored.map((s) => s.url.hostname)).not.toContain("evil.example");
    expect(scored.some((s) => s.url.hostname === "boards.greenhouse.io")).toBe(
      true,
    );
  });

  it("follows the best link, else probes known paths in order", async () => {
    const fetched: string[] = [];
    const fetchImpl = routeFetch({
      "https://acme.example/robots.txt": () =>
        new Response("", { status: 404 }),
      "https://acme.example/": () => new Response("<a href='/team'>Team</a>"),
      "https://acme.example/careers": () => new Response("", { status: 404 }),
      "https://acme.example/jobs": () => new Response("<h1>Jobs at Acme</h1>"),
    });
    const tracking = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input));
      return fetchImpl(input, init);
    }) as typeof fetch;
    const robots = new RobotsCache({
      fetchImpl: tracking,
      resolveHost: publicHost,
    });
    const page = await findCareersPage("acme.example", {
      fetchImpl: tracking,
      resolveHost: publicHost,
      robots,
    });
    expect(page?.finalUrl.href).toBe("https://acme.example/jobs");
    expect(fetched.indexOf("https://acme.example/careers")).toBeLessThan(
      fetched.indexOf("https://acme.example/jobs"),
    );
    expect(careersProbePaths[0]).toBe("/careers");
  });

  it("propagates a robots refusal on the best-scoring link instead of falling through to probe paths", async () => {
    const fetched: string[] = [];
    const fetchImpl = routeFetch({
      "https://blocked.example/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /careers"),
      "https://blocked.example/": () =>
        new Response('<a href="/careers">Careers</a>'),
      // If the robots refusal were swallowed, the probe list would reach here.
      "https://blocked.example/jobs": () =>
        new Response("<h1>Jobs at Blocked</h1>"),
    });
    const tracking = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input));
      return fetchImpl(input, init);
    }) as typeof fetch;
    await expect(
      findCareersPage("blocked.example", {
        fetchImpl: tracking,
        resolveHost: publicHost,
        robots: new RobotsCache({
          fetchImpl: tracking,
          resolveHost: publicHost,
        }),
      }),
    ).rejects.toBeInstanceOf(RobotsBlockedError);
    expect(fetched).not.toContain("https://blocked.example/jobs");
  });

  it("returns null when neither homepage links nor probes find a page", async () => {
    const fetchImpl = routeFetch({
      "https://none.example/robots.txt": () =>
        new Response("", { status: 404 }),
      "https://none.example/": () => new Response("<p>Hello</p>"),
      "https://www.none.example/robots.txt": () =>
        new Response("", { status: 404 }),
    });
    const page = await findCareersPage("none.example", {
      fetchImpl,
      resolveHost: publicHost,
      robots: new RobotsCache({ fetchImpl, resolveHost: publicHost }),
    });
    expect(page).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { detectAts } from "@jobfinder/discovery";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/discovery/ats/${name}`, import.meta.url),
    "utf8",
  );

describe("Phase 5 ATS detector", () => {
  const at = (href: string, html: string, chain = [href]) =>
    detectAts({ finalUrl: new URL(href), chain, html });

  it("finds Greenhouse embeds, Lever links and Ashby iframes with their keys", () => {
    expect(
      at("https://acme.example/careers", fixture("greenhouse-embed.html")),
    ).toEqual({
      ats: "Greenhouse",
      key: "acmecorp",
    });
    expect(
      at("https://acme.example/careers", fixture("lever-link.html")),
    ).toEqual({
      ats: "Lever",
      key: "acme-labs",
    });
    expect(
      at("https://acme.example/careers", fixture("ashby-iframe.html")),
    ).toEqual({
      ats: "Ashby",
      key: "acme",
    });
  });

  it("reads the redirect chain and recognises unsupported vendors", () => {
    expect(
      at(
        "https://acme.wd5.myworkdayjobs.com/en-US/External",
        fixture("workday-redirect.html"),
        [
          "https://acme.example/careers",
          "https://acme.wd5.myworkdayjobs.com/en-US/External",
        ],
      ),
    ).toEqual({ ats: "Workday", key: "acme" });
    expect(at("https://jobs.smartrecruiters.com/AcmeInc/", "<p>x</p>")).toEqual(
      { ats: "SmartRecruiters", key: "AcmeInc" },
    );
    expect(at("https://careers-acme.icims.com/jobs/intro", "<p>x</p>")).toEqual(
      {
        ats: "iCIMS",
        key: "careers-acme",
      },
    );
    expect(
      at("https://acme.taleo.net/careersection/2/jobsearch.ftl", "<p>x</p>"),
    ).toEqual({
      ats: "Taleo",
      key: "acme",
    });
  });

  it("returns null for a plain careers page", () => {
    expect(
      at("https://acme.example/careers", "<a href='/jobs/1'>Engineer</a>"),
    ).toBeNull();
  });

  it("resolves Greenhouse's /v1/boards/{key} form and its keyless /embed path, Lever's /v0/postings/{key} form, and excludes Ashby's posting-api host segment", () => {
    expect(
      at("https://boards.greenhouse.io/v1/boards/acmecorp/jobs", "<p>x</p>"),
    ).toEqual({ ats: "Greenhouse", key: "acmecorp" });
    expect(
      at("https://boards.greenhouse.io/embed/job_app", "<p>x</p>"),
    ).toBeNull();
    expect(
      at("https://api.lever.co/v0/postings/acme-labs", "<p>x</p>"),
    ).toEqual({ ats: "Lever", key: "acme-labs" });
    expect(
      at("https://api.ashbyhq.com/posting-api/job-board/acme", "<p>x</p>"),
    ).toBeNull();
  });
});

/**
 * Akamai Bot Manager (lululemon, and every other site behind it) resets the
 * connection for any user agent containing "bot" or "curl" before sending a
 * response, so a request never fails fast — it hangs until the fetch timeout.
 * Discovery must identify itself without a token those filters match.
 */
describe("Phase 5 discovery user agent", () => {
  it("identifies itself without a token bot filters reject", () => {
    expect(discoveryUserAgent).toBe("JobFinder/1.0");
    expect(discoveryUserAgent).not.toMatch(/bot|crawler|spider|curl/i);
  });

  it("sends that user agent on robots.txt and on page fetches", async () => {
    const seen: { url: string; agent: string | null }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({
        url,
        agent: new Headers(init?.headers).get("user-agent"),
      });
      return url.endsWith("/robots.txt")
        ? new Response("User-agent: *\nDisallow: /private\n")
        : new Response("<p>ok</p>");
    }) as typeof fetch;
    await discoveryFetch(new URL("https://ua.example/careers"), {
      fetchImpl,
      resolveHost: publicHost,
      robots: new RobotsCache({ fetchImpl, resolveHost: publicHost }),
    });
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://ua.example/robots.txt",
      "https://ua.example/careers",
    ]);
    for (const entry of seen) expect(entry.agent).toBe("JobFinder/1.0");
  });

  it("honours a robots group named for its own agent token", async () => {
    const rules = parseRobots(
      "User-agent: *\nAllow: /\n\nUser-agent: JobFinder\nDisallow: /careers\n",
    );
    const token = discoveryUserAgent.split("/")[0];
    expect(robotsAllows(rules, "/careers", token)).toEqual({
      allowed: false,
      matchedRule: "Disallow: /careers",
    });
  });

  it("reports the same agent in the recorded policy check", async () => {
    const fetchImpl = routeFetch({
      "https://ua2.example/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /careers\n"),
    });
    const robots = new RobotsCache({ fetchImpl, resolveHost: publicHost });
    expect(
      await robots.check(new URL("https://ua2.example/careers")),
    ).toMatchObject({ robotsAllowed: false, userAgent: "JobFinder/1.0" });
  });
});
