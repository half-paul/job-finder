// tests/unit/discovery-connectors.test.ts
import { describe, expect, it } from "vitest";
import {
  collectPostingLinks,
  createConnector,
  extractJsonLdJobs,
  providerName,
} from "@jobfinder/job-sources";

const routeFetch = (routes: Record<string, () => Response>) =>
  (async (input: RequestInfo | URL) => {
    const key = String(input instanceof Request ? input.url : input);
    return routes[key]?.() ?? new Response("missing", { status: 404 });
  }) as typeof fetch;

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

describe("Phase 5 posting links and JSON-LD careers connector", () => {
  it("collects same-host posting links only, in order, deduped", () => {
    const html = `
      <a href="/jobs/101-director-product">Director</a>
      <a href="/jobs/101-director-product?ref=x">Director again</a>
      <a href="/careers/openings/vp-eng">VP Eng</a>
      <a href="https://other.example/jobs/5">Other</a>
      <a href="/about">About</a>
      <a href="/jobs">All jobs</a>`;
    const links = collectPostingLinks(
      html,
      new URL("https://acme.example/careers"),
    );
    expect(links.map((u: URL) => u.pathname)).toEqual([
      "/jobs/101-director-product",
      "/careers/openings/vp-eng",
    ]);
  });

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
    const connector = createConnector("Careers", {
      fetchImpl: routeFetch({
        "https://acme.example/careers": () => new Response(html),
      }),
    });
    const query = {
      board: "acme.example",
      terms: [],
      company: "Acme",
      sourceUrl: "https://acme.example/careers",
    };
    const normalized = await connector.normalize(raw, { query });
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

  it("walks a listing page that only links to posting pages", async () => {
    const fetchImpl = routeFetch({
      "https://acme.example/careers": () =>
        new Response(`<a href="/jobs/1">One</a><a href="/jobs/2">Two</a>`),
      "https://acme.example/jobs/1": () => new Response(posting("1")),
      "https://acme.example/jobs/2": () =>
        new Response("<p>no structured data</p>"),
    });
    const connector = createConnector("Careers", { fetchImpl });
    const query = {
      board: "acme.example",
      terms: [],
      company: "Acme",
      sourceUrl: "https://acme.example/careers",
    };
    const page = await connector.search(query);
    expect(page.complete).toBe(true);
    expect(page.jobs.map((j) => j.externalId)).toEqual([
      "https://acme.example/jobs/1",
      "https://acme.example/jobs/2",
    ]);
    const raw = await connector.fetchJob(page.jobs[0]);
    expect((await connector.normalize(raw, { query })).title).toBe(
      "Director of Product 1",
    );
    await expect(connector.fetchJob(page.jobs[1])).rejects.toThrow(
      /no JobPosting/,
    );
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
