// tests/unit/discovery-connectors.test.ts
import { describe, expect, it } from "vitest";
import {
  capturedApiMaxJobs,
  createConnector,
  extractJsonLdJobs,
  normalizeJsonLdJob,
  providerName,
  type ConnectorOptions,
} from "@jobfinder/job-sources";
import type { CrawlPatternSpec } from "@jobfinder/shared";

const posting = (id: string, extra = "") => `
<script type="application/ld+json">{
  "@context":"https://schema.org","@type":"JobPosting",
  "title":"Director of Product ${id}","identifier":"${id}",
  "description":"<p>Lead product for a growing platform team across regions.</p>",
  "url":"https://acme.example/jobs/${id}","datePosted":"2026-09-01",
  "employmentType":"FULL_TIME",
  "hiringOrganization":{"name":"Acme"},
  "jobLocation":{"address":{"addressLocality":"Toronto","addressRegion":"ON","addressCountry":"CA"}}
  ${extra}
}</script>`;

describe("Phase 5 JSON-LD normalization", () => {
  it("reads salary, remote type and applicant countries from JSON-LD", async () => {
    const html = posting(
      "7",
      `,"jobLocationType":"TELECOMMUTE",
       "applicantLocationRequirements":{"@type":"Country","name":"Canada"},
       "baseSalary":{"@type":"MonetaryAmount","currency":"CAD",
         "value":{"@type":"QuantitativeValue","minValue":180000,"maxValue":220000,"unitText":"YEAR"}},
       "validThrough":"2026-12-31"`,
    );
    const [raw] = extractJsonLdJobs(html);
    const query = {
      board: "acme.example",
      terms: [],
      company: "Acme",
      sourceUrl: "https://acme.example/careers",
    };
    const normalized = await normalizeJsonLdJob(raw, { query }, "Careers");
    expect(normalized).toMatchObject({
      provider: "Careers",
      workType: "Remote",
      salaryMin: 180000,
      salaryMax: 220000,
      currency: "CAD",
      salaryPeriod: "year",
      country: "CA",
    });
    expect(normalized.location).toContain("Canada");
  });

  it("falls back to a single salary value, classifies employment type, and reads array-form location fields", async () => {
    const html = posting(
      "8",
      `,"employmentType":["FULL_TIME","Contract"],
       "jobLocation":[{"address":{"addressLocality":"Austin","addressRegion":"TX","addressCountry":{"name":"United States"}}}],
       "applicantLocationRequirements":[{"name":"United States"},{"name":"Canada"}],
       "baseSalary":{"@type":"MonetaryAmount","currency":"eur",
         "value":{"@type":"QuantitativeValue","value":95000,"unitText":"month"}},
       "hiringOrganization":{}`,
    );
    const [raw] = extractJsonLdJobs(html);
    const query = {
      board: "acme.example",
      terms: [],
      sourceUrl: "https://acme.example/careers",
    };
    const normalized = await normalizeJsonLdJob(raw, { query }, "Careers");
    expect(normalized).toMatchObject({
      salaryMin: 95000,
      salaryMax: 95000,
      salaryPeriod: "month",
      currency: "EUR",
      employmentType: "Contract",
      company: "acme.example", // no hiringOrganization.name and no query.company: falls back to board
    });
    expect(normalized.location).toContain("Austin, TX");
    expect(normalized.location).toContain("Applicants: United States, Canada");
  });

  it("treats a non-numeric salary as unknown rather than zero", async () => {
    // "Competitive" strips to "" and Number("") is 0, so this used to render
    // a $0 salary and hand the evaluator a figure the posting never stated.
    const html = posting(
      "9",
      `,"baseSalary":{"@type":"MonetaryAmount","currency":"USD",
         "value":{"@type":"QuantitativeValue","value":"Competitive","unitText":"YEAR"}}`,
    );
    const [raw] = extractJsonLdJobs(html);
    const normalized = await normalizeJsonLdJob(
      raw,
      {
        query: {
          board: "acme.example",
          terms: [],
          sourceUrl: "https://acme.example/careers",
        },
      },
      "Careers",
    );
    expect(normalized.salaryMin).toBeNull();
    expect(normalized.salaryMax).toBeNull();
  });

  it("reports an unrecognised currency as Unknown", async () => {
    const html = posting(
      "9",
      `,"baseSalary":{"@type":"MonetaryAmount","currency":"XYZ","value":{"minValue":1,"maxValue":2}}`,
    );
    const [raw] = extractJsonLdJobs(html);
    const normalized = await normalizeJsonLdJob(
      raw,
      {
        query: {
          board: "acme.example",
          terms: [],
          sourceUrl: "https://acme.example/careers",
        },
      },
      "Careers",
    );
    expect(normalized.currency).toBe("Unknown");
  });

  it("recognises the new provider names", () => {
    expect(providerName("careers")).toBe("Careers");
    expect(providerName("captured-api")).toBe("CapturedApi");
    expect(providerName("browser")).toBe("Browser");
  });
});

import {
  createHttpCrawlerClient,
  crawlerClientFromEnv,
  type CrawlerClient,
} from "@jobfinder/job-sources";

const fakeCrawler = (
  jobs: Array<{
    title: string;
    url: string;
    id?: string;
    location?: string;
    description?: string;
  }>,
  complete = true,
): CrawlerClient => ({
  crawl: async () => ({
    jobs: jobs.map((j) => ({
      location: "",
      description: "",
      postedAt: null,
      ...j,
    })),
    complete,
    warnings: [],
  }),
  capture: async () => ({ patterns: [], warnings: [] }),
});

describe("Phase 5 crawler client and Browser connector", () => {
  it("sends the bearer secret and validates the response", async () => {
    let auth = "";
    const client = createHttpCrawlerClient({
      url: "http://crawler:4000",
      secret: "s3cret",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        expect(String(input)).toBe("http://crawler:4000/crawl");
        return new Response(
          JSON.stringify({ jobs: [], complete: true, warnings: [] }),
        );
      }) as typeof fetch,
    });
    await client.crawl({
      url: "https://acme.example/careers",
      maxPages: 1,
      maxJobs: 1,
    });
    expect(auth).toBe("Bearer s3cret");
    const bad = createHttpCrawlerClient({
      url: "http://crawler:4000",
      secret: "s",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ nope: 1 }))) as typeof fetch,
    });
    await expect(
      bad.crawl({ url: "https://a.example/", maxPages: 1, maxJobs: 1 }),
    ).rejects.toThrow(/invalid/i);
    const refused = createHttpCrawlerClient({
      url: "http://crawler:4000",
      secret: "s",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "robots", kind: "blocked" }), {
          status: 422,
        })) as typeof fetch,
    });
    await expect(
      refused.crawl({ url: "https://a.example/", maxPages: 1, maxJobs: 1 }),
    ).rejects.toMatchObject({ kind: "blocked" });
  });

  it("is null without configuration", () => {
    expect(crawlerClientFromEnv({})).toBeNull();
    expect(
      crawlerClientFromEnv({
        CRAWLER_URL: "http://c:4000",
        CRAWLER_SECRET: "x",
      }),
    ).not.toBeNull();
  });

  it("turns crawled postings into normalized jobs and flags incomplete walks", async () => {
    const connector = createConnector("Browser", {
      crawlerClient: fakeCrawler(
        [
          {
            title: "Head of Growth",
            url: "https://acme.example/jobs/9",
            id: "9",
            location: "Remote - Canada",
            description: "Own growth across the funnel and lead a small team.",
          },
          { title: "Ops Lead", url: "https://acme.example/jobs/10" },
        ],
        false,
      ),
    });
    const query = {
      board: "acme.example",
      terms: [],
      company: "Acme",
      sourceUrl: "https://acme.example/careers",
    };
    const page = await connector.search(query);
    expect(page.complete).toBe(false);
    expect(page.jobs.map((j) => j.externalId)).toEqual([
      "9",
      "https://acme.example/jobs/10",
    ]);
    const first = await connector.normalize(
      await connector.fetchJob(page.jobs[0]),
      { query },
    );
    expect(first).toMatchObject({
      provider: "Browser",
      workType: "Remote",
      company: "Acme",
      title: "Head of Growth",
    });
    const second = await connector.normalize(
      await connector.fetchJob(page.jobs[1]),
      { query },
    );
    expect(second.description).toContain("No description was captured");
  });

  it("wraps invalid JSON and unparseable error bodies as internal errors, and validates capture()", async () => {
    const invalidJson = createHttpCrawlerClient({
      url: "http://crawler:4000",
      secret: "s",
      fetchImpl: (async () => new Response("not json")) as typeof fetch,
    });
    await expect(
      invalidJson.crawl({ url: "https://a.example/", maxPages: 1, maxJobs: 1 }),
    ).rejects.toMatchObject({
      kind: "internal",
      message: "Crawler returned invalid JSON",
    });
    const opaqueError = createHttpCrawlerClient({
      url: "http://crawler:4000",
      secret: "s",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ nope: 1 }), {
          status: 500,
        })) as typeof fetch,
    });
    await expect(
      opaqueError.crawl({ url: "https://a.example/", maxPages: 1, maxJobs: 1 }),
    ).rejects.toMatchObject({
      kind: "internal",
      message: "Crawler returned HTTP 500",
    });
    const client = createHttpCrawlerClient({
      url: "http://crawler:4000",
      secret: "s",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            patterns: [
              {
                url: "https://acme.example/api/jobs",
                method: "GET",
                headers: {},
                body: null,
                jobsPath: "/jobs",
                sample: [{}],
              },
            ],
            warnings: [],
          }),
        )) as typeof fetch,
    });
    const captured = await client.capture({
      url: "https://acme.example/careers",
    });
    expect(captured.patterns).toHaveLength(1);
  });

  it("fails loudly when the crawler is not configured", async () => {
    const connector = createConnector("Browser", { crawlerClient: null });
    await expect(
      connector.search({
        board: "a",
        terms: [],
        sourceUrl: "https://a.example/careers",
      }),
    ).rejects.toThrow(
      "Browser crawling is not configured; start the crawler service",
    );
  });
});

const spec: CrawlPatternSpec = {
  urlTemplate: "https://acme.example/api/jobs?page={page}",
  method: "GET",
  headers: { accept: "application/json" },
  body: null,
  jobsPath: "/data/results",
  fieldMap: {
    title: "/title",
    url: "/absolute_url",
    id: "/id",
    location: "/location/name",
    description: "/content",
    postedAt: "/updated_at",
  },
};

const pagedFetch = (pages: Record<string, unknown[]>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const page = url.searchParams.get("page") ?? "1";
    return new Response(
      JSON.stringify({ data: { results: pages[page] ?? [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

const capturedPosting = (id: number) => ({
  id: String(id),
  title: `Engineer ${id}`,
  absolute_url: `https://acme.example/jobs/${id}`,
  location: { name: "Vancouver, BC" },
  content: "We are hiring an engineer to work on the thing.",
  updated_at: "2026-09-01T00:00:00Z",
});

describe("CapturedApi connector", () => {
  const options = (
    extra: Partial<ConnectorOptions> = {},
  ): ConnectorOptions => ({
    crawlPattern: spec,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    ...extra,
  });

  it("walks pages until one comes back empty", async () => {
    const connector = createConnector(
      "CapturedApi",
      options({
        fetchImpl: pagedFetch({
          "1": [capturedPosting(1), capturedPosting(2)],
          "2": [capturedPosting(3)],
        }),
      }),
    );
    const page = await connector.search({
      board: "acme",
      terms: [],
      company: "Acme",
    });
    expect(page.jobs.map((j) => j.externalId)).toEqual(["1", "2", "3"]);
    expect(page.complete).toBe(true);
    expect(page.canMarkRemovals).toBe(true);
  });

  it("maps a posting through the field map", async () => {
    const connector = createConnector(
      "CapturedApi",
      options({ fetchImpl: pagedFetch({ "1": [capturedPosting(7)] }) }),
    );
    const page = await connector.search({
      board: "acme",
      terms: [],
      company: "Acme",
    });
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, {
      query: { board: "acme", terms: [], company: "Acme" },
    });
    expect(job).toMatchObject({
      title: "Engineer 7",
      company: "Acme",
      location: "Vancouver, BC",
      jobUrl: "https://acme.example/jobs/7",
      externalId: "7",
      provider: "CapturedApi",
    });
  });

  it("resolves a relative posting URL against the pattern origin", async () => {
    const relative = { ...capturedPosting(9), absolute_url: "/jobs/9" };
    const connector = createConnector(
      "CapturedApi",
      options({ fetchImpl: pagedFetch({ "1": [relative] }) }),
    );
    const page = await connector.search({
      board: "acme",
      terms: [],
      company: "Acme",
    });
    expect(page.jobs[0].url).toBe("https://acme.example/jobs/9");
  });

  it("refuses to run without a saved pattern", async () => {
    const connector = createConnector(
      "CapturedApi",
      options({ crawlPattern: null }),
    );
    await expect(
      connector.search({ board: "acme", terms: [] }),
    ).rejects.toThrow(/saved API pattern/i);
  });

  it("throws when a replay yields no parseable posting", async () => {
    const connector = createConnector(
      "CapturedApi",
      options({ fetchImpl: pagedFetch({ "1": [{ nope: true }] }) }),
    );
    await expect(
      connector.search({ board: "acme", terms: [], company: "Acme" }),
    ).rejects.toThrow(/no parseable posting/i);
  });

  it("treats hitting the job cap on an exact page boundary as incomplete", async () => {
    // The bug: when the last usable posting of a page brings jobs.length to
    // exactly maxJobs, the inner per-entry cap check never fires (it only
    // triggers on a *leftover* entry after the cap), and the outer loop just
    // stops because `jobs.length < maxJobs` goes false — without `page` ever
    // exceeding maxPages either. Both existing "incomplete" guards can miss
    // this exact boundary, so `complete` (and `canMarkRemovals`) must be
    // computed against the job count directly.
    const perPage = 100;
    const fullPages = capturedApiMaxJobs / perPage;
    const pages: Record<string, unknown[]> = {};
    let id = 1;
    for (let p = 1; p <= fullPages; p++) {
      pages[String(p)] = Array.from({ length: perPage }, () =>
        capturedPosting(id++),
      );
    }
    // One more page proves postings exist beyond the cap.
    pages[String(fullPages + 1)] = [capturedPosting(id)];
    const connector = createConnector(
      "CapturedApi",
      options({ fetchImpl: pagedFetch(pages) }),
    );
    const page = await connector.search({
      board: "acme",
      terms: [],
      company: "Acme",
    });
    expect(page.jobs).toHaveLength(capturedApiMaxJobs);
    expect(page.complete).toBe(false);
    expect(page.canMarkRemovals).toBe(false);
  });
});
