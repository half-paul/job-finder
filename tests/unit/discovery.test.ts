import { describe, expect, it } from "vitest";
import {
  candidateStatusLabel,
  companyImportSchema,
  crawlPatternSpecSchema,
  crawlResponseSchema,
  jsonPointerGet,
} from "@jobfinder/shared";

describe("Phase 5 shared discovery contracts", () => {
  it("labels every candidate status in plain language", () => {
    expect(candidateStatusLabel.Pending).toBe("Waiting for worker");
    expect(candidateStatusLabel.Blocked).toBe("Robots.txt disallows crawling");
    expect(candidateStatusLabel.Unsupported).toBe(
      "Vendor recognised, not yet supported",
    );
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
      { name: "beta.io", domain: "beta.io" },
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
});

import {
  RobotsBlockedError,
  RobotsCache,
  discoveryFetch,
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
      userAgent: "JobFinderBot/1.0",
      matchedRule: "Disallow: /careers",
    });
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
