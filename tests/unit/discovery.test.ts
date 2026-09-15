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
