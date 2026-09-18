// tests/unit/discovery-edges.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  createConnector,
  extractJsonLdJobs,
  jsonLdExternalId,
} from "@jobfinder/job-sources";
import {
  createAdaptiveCareersConnector,
  parseRobots,
  parseSeedList,
  robotsAllows,
} from "@jobfinder/discovery";
import { recordActivities } from "@jobfinder/automation";

const fixtureFetch = (routes: Record<string, string | Response>) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const value = routes[String(input)];
    return value instanceof Response
      ? value.clone()
      : new Response(value ?? "missing", {
          status: value === undefined ? 404 : 200,
        });
  }) as unknown as typeof fetch;

const ldScript = (fields: Record<string, unknown>) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Director of Product",
    description:
      "<p>Lead product for a growing platform team across several regions.</p>",
    url: "https://acme.example/jobs/1",
    ...fields,
  })}</script>`;

const query = {
  board: "acme.example",
  terms: [],
  sourceUrl: "https://acme.example/careers",
};

const normalizeCareers = (html: string) => {
  const [raw] = extractJsonLdJobs(html);
  return createConnector("Careers", {
    fetchImpl: fixtureFetch({ "https://acme.example/careers": html }),
  }).normalize(raw, { query });
};

describe("JSON-LD external identity", () => {
  it("reads an object identifier and stringifies a numeric one", () => {
    const [nested] = extractJsonLdJobs(
      ldScript({ identifier: { value: "REQ-77" } }),
    );
    const [numeric] = extractJsonLdJobs(ldScript({ identifier: 4711 }));
    expect(jsonLdExternalId(nested)).toBe("REQ-77");
    expect(jsonLdExternalId(numeric)).toBe("4711");
  });

  it("falls back to the posting URL when no identifier is present", () => {
    const [job] = extractJsonLdJobs(ldScript({}));
    expect(jsonLdExternalId(job)).toBe("https://acme.example/jobs/1");
  });

  // Regression: a blank identifier used to be falsy and fell through to the
  // URL. Returning "" would collapse every such posting onto one external id,
  // so a scan would import a single job and mark the rest as duplicates.
  it("falls back to the posting URL for a blank identifier in either form", () => {
    const [empty] = extractJsonLdJobs(ldScript({ identifier: "" }));
    const [blankNested] = extractJsonLdJobs(
      ldScript({
        identifier: { value: "   " },
        url: "https://acme.example/jobs/2",
      }),
    );
    expect(jsonLdExternalId(empty)).toBe("https://acme.example/jobs/1");
    expect(jsonLdExternalId(blankNested)).toBe("https://acme.example/jobs/2");
  });
});

describe("JSON-LD normalization edges", () => {
  it("treats a TELECOMMUTE location type as remote without the word appearing", async () => {
    const normalized = await normalizeCareers(
      ldScript({ jobLocationType: "TELECOMMUTE" }),
    );
    expect(normalized.workType).toBe("Remote");
    expect(normalized.description).not.toMatch(/remote/i);
  });

  it("classifies a temporary posting and keeps a plain country string", async () => {
    const normalized = await normalizeCareers(
      ldScript({
        employmentType: "TEMPORARY",
        jobLocation: {
          address: { addressLocality: "Ottawa", addressCountry: "CA" },
        },
      }),
    );
    expect(normalized.employmentType).toBe("Temporary");
    expect(normalized.country).toBe("CA");
    expect(normalized.location).toBe("Ottawa");
  });

  it("reads a min/max salary range with its period and currency", async () => {
    const normalized = await normalizeCareers(
      ldScript({
        baseSalary: {
          currency: "gbp",
          value: { minValue: 80000, maxValue: "120000", unitText: "YEAR" },
        },
      }),
    );
    expect(normalized).toMatchObject({
      salaryMin: 80000,
      salaryMax: 120000,
      salaryPeriod: "year",
      currency: "GBP",
    });
  });
});

describe("adaptive careers connector limits", () => {
  it("requires a careers URL before doing any network work", async () => {
    const fetchImpl = fixtureFetch({});
    const connector = createAdaptiveCareersConnector({
      extractPage: vi.fn(),
      fetchImpl,
    });
    await expect(
      connector.search({ board: "acme", terms: [] }),
    ).rejects.toThrow("A careers URL is required.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a malformed structured url instead of failing the whole scan", async () => {
    // jsonLdJobSchema declares url as a bare string, so a relative or blank
    // url used to throw out of search() and import zero jobs from the site.
    const page =
      ldScript({ identifier: "REQ-1" }) +
      ldScript({ identifier: "REQ-REL", url: "/jobs/relative" }) +
      ldScript({ identifier: "REQ-BAD", url: "javascript:alert(1)" }) +
      ldScript({ identifier: "REQ-HTTP", url: "http://acme.example/jobs/2" });
    const connector = createAdaptiveCareersConnector({
      extractPage: vi.fn(),
      fetchImpl: fixtureFetch({ "https://acme.example/careers": page }),
    });
    const result = await connector.search(query);
    const ids = result.jobs.map((job) => job.externalId);
    expect(ids).toContain("REQ-1");
    expect(ids).toContain("REQ-REL");
    expect(ids).not.toContain("REQ-BAD");
    expect(ids).not.toContain("REQ-HTTP");
  });

  it("stops at the hundred-listing cap and reports the walk incomplete", async () => {
    const jobs = Array.from({ length: 120 }, (_, index) =>
      ldScript({
        title: `Engineer ${index}`,
        url: `https://acme.example/jobs/${index}`,
        identifier: `REQ-${index}`,
      }),
    ).join("");
    const connector = createAdaptiveCareersConnector({
      extractPage: vi.fn(),
      fetchImpl: fixtureFetch({ "https://acme.example/careers": jobs }),
    });
    const page = await connector.search(query);
    expect(page.jobs).toHaveLength(100);
    expect(page.complete).toBe(false);
    expect(page.canMarkRemovals).toBe(false);
  });

  it("follows a pagination link from a structured listing page", async () => {
    const connector = createAdaptiveCareersConnector({
      extractPage: vi.fn(),
      fetchImpl: fixtureFetch({
        "https://acme.example/careers":
          ldScript({ identifier: "REQ-1" }) +
          `<a href="https://acme.example/careers?page=2">View all roles</a>` +
          `<a href="https://acme.example/about">About us</a>`,
        "https://acme.example/careers?page=2": ldScript({
          identifier: "REQ-2",
          url: "https://acme.example/jobs/2",
        }),
      }),
    });
    const page = await connector.search(query);
    expect(page.jobs.map((job) => job.externalId).sort()).toEqual([
      "REQ-1",
      "REQ-2",
    ]);
    expect(page.complete).toBe(true);
  });

  it("drops a structured listing hosted outside the company or an ATS", async () => {
    const connector = createAdaptiveCareersConnector({
      extractPage: vi.fn(),
      fetchImpl: fixtureFetch({
        "https://acme.example/careers":
          ldScript({ identifier: "REQ-1" }) +
          ldScript({
            identifier: "REQ-OFFSITE",
            url: "https://aggregator.example/jobs/9",
          }),
      }),
    });
    const page = await connector.search(query);
    expect(page.jobs.map((job) => job.url)).toEqual([
      "https://acme.example/jobs/1",
    ]);
  });

  it("refuses to fetch a posting that this scan never extracted", async () => {
    const connector = createAdaptiveCareersConnector({
      extractPage: vi.fn(),
      fetchImpl: fixtureFetch({
        "https://acme.example/careers": ldScript({ identifier: "REQ-1" }),
      }),
    });
    await connector.search(query);
    expect(
      await connector.fetchJob({ externalId: "REQ-1", url: "" }),
    ).toMatchObject({ url: "https://acme.example/jobs/1" });
    await expect(
      connector.fetchJob({ externalId: "REQ-missing", url: "" }),
    ).rejects.toThrow("missing from this scan");
  });
});

describe("ATS detection corroboration", () => {
  it("ignores a bare partner link to another company's board", async () => {
    const { detectAts } = await import("@jobfinder/discovery");
    const html =
      '<a href="https://boards.greenhouse.io/partnerco">PartnerCo</a>';
    expect(
      detectAts({
        finalUrl: new URL("https://acme.example/"),
        chain: [],
        html,
      }),
    ).toBeNull();
  });

  it("still detects a board behind a link that reads as careers", async () => {
    const { detectAts } = await import("@jobfinder/discovery");
    const html = '<a href="https://jobs.lever.co/acme">Open roles</a>';
    expect(
      detectAts({
        finalUrl: new URL("https://acme.example/"),
        chain: [],
        html,
      }),
    ).toMatchObject({ ats: "Lever", key: "acme" });
  });
});

describe("hostile robots rules", () => {
  it("matches a wildcard-heavy rule in bounded time", () => {
    // A site serving this rule used to hang the matcher indefinitely, and
    // because matching is synchronous it froze the whole worker.
    const rules = parseRobots(
      `User-agent: *\nDisallow: /${"a*".repeat(24)}b\n`,
    );
    const start = Date.now();
    robotsAllows(rules, `/${"a".repeat(60)}`, "JobFinderBot");
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("keeps wildcard and end-anchor semantics", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /a*/c\nDisallow: /x.pdf$\n",
    );
    expect(robotsAllows(rules, "/abbb/c", "JobFinderBot").allowed).toBe(false);
    expect(robotsAllows(rules, "/x.pdf", "JobFinderBot").allowed).toBe(false);
    expect(robotsAllows(rules, "/x.pdf?a=1", "JobFinderBot").allowed).toBe(
      true,
    );
  });
});

describe("robots grouping details", () => {
  it("shares one rule set between consecutive user-agent lines and starts a new group after a rule", () => {
    const rules = parseRobots(
      [
        "User-agent: alpha",
        "User-agent: beta",
        "Disallow: /internal",
        "User-agent: gamma",
        "Disallow: /other",
      ].join("\n"),
    );
    expect(robotsAllows(rules, "/internal/x", "alpha").allowed).toBe(false);
    expect(robotsAllows(rules, "/internal/x", "beta").allowed).toBe(false);
    expect(robotsAllows(rules, "/internal/x", "gamma").allowed).toBe(true);
    expect(robotsAllows(rules, "/other/x", "gamma").allowed).toBe(false);
  });

  it("ignores comments and treats an empty Disallow as permission", () => {
    const rules = parseRobots(
      "# site policy\nUser-agent: *\nDisallow: /private # staff only\nDisallow:",
    );
    expect(robotsAllows(rules, "/private/x", "JobFinderBot")).toEqual({
      allowed: false,
      matchedRule: "Disallow: /private",
    });
    expect(robotsAllows(rules, "/careers", "JobFinderBot").allowed).toBe(true);
  });

  it("lets Allow win a tie against an equally specific Disallow", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /careers\nAllow: /careers",
    );
    expect(robotsAllows(rules, "/careers/open", "JobFinderBot")).toEqual({
      allowed: true,
    });
  });
});

describe("seed list quoted fields", () => {
  it("keeps a company name that contains a comma and its careers URL", () => {
    const result = parseSeedList('"Acme, Inc.","https://acme.com/careers"');
    expect(result.rejected).toEqual([]);
    expect(result.rows).toEqual([
      {
        name: "Acme, Inc.",
        domain: "acme.com",
        websiteUrl: "https://acme.com/careers",
      },
    ]);
  });

  it("unescapes doubled quotes inside a name", () => {
    const result = parseSeedList('"Acme ""Labs""",acme.com');
    expect(result.rows).toEqual([{ name: 'Acme "Labs"', domain: "acme.com" }]);
  });
});

describe("activity batching", () => {
  const stubDb = () => {
    const batches: { message: string }[][] = [];
    const db = {
      insert: () => ({
        values: async (rows: { message: string }[]) => {
          batches.push(rows);
        },
      }),
    };
    return {
      batches,
      db: db as unknown as Parameters<typeof recordActivities>[0],
    };
  };

  it("truncates a long message to a thousand characters", async () => {
    const { batches, db } = stubDb();
    await recordActivities(db, [
      {
        userId: "11111111-1111-4111-8111-111111111111",
        actor: "Worker",
        stage: "import",
        message: "x".repeat(1500),
      },
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].message).toHaveLength(1000);
  });

  it("writes nothing at all for an empty batch", async () => {
    const db = {
      insert: () => {
        throw new Error("recordActivities must not open a write for no events");
      },
    } as unknown as Parameters<typeof recordActivities>[0];
    await expect(recordActivities(db, [])).resolves.toBeUndefined();
  });
});
