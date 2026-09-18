import { describe, expect, it } from "vitest";
import {
  createConnector,
  fetchText,
  htmlToText,
  providerName,
  retryAfterMs,
  type ConnectorOptions,
} from "@jobfinder/job-sources";

const jsonFetch = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  (async () =>
    new Response(JSON.stringify(body), { status, headers })) as typeof fetch;

describe("Phase 2 source connectors", () => {
  it("converts untrusted HTML into bounded plain text", () => {
    expect(
      htmlToText(
        "<style>.x{color:red}</style><script>alert(1)</script><p>Amp & safe</p><br/><h2>Lead</h2>",
      ),
    ).toBe("Amp & safe\nLead");
  });

  it("normalizes and deduplicates a Greenhouse page in one request", async () => {
    let calls = 0;
    const options: ConnectorOptions = {
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 44444,
                title: "Product Engineer",
                company_name: "",
                content: "<p>Build <strong>secure</strong> systems.</p>",
                first_published: "2013-08-01T20:00:00Z",
                location: { name: "Remote, Canada" },
                offices: [],
                absolute_url: "https://boards.greenhouse.io/example/jobs/44444",
              },
            ],
          }),
        );
      },
    };
    const connector = createConnector("Greenhouse", options);
    const query = {
      board: "example",
      terms: [],
      company: "Example Inc.",
    };
    const page = await connector.search(query);
    expect(page.complete).toBe(true);
    expect(page.jobs).toEqual(
      [
        {
          externalId: "44444",
          url: "https://boards.greenhouse.example/jobs/44444",
          board: "example",
          company: "Example Inc.",
        },
      ].map((job) => ({
        ...job,
        url: "https://boards.greenhouse.io/example/jobs/44444",
      })),
    );
    const raw = await connector.fetchJob(page.jobs[0]);
    const normalized = await connector.normalize(raw, { query });
    expect(normalized).toMatchObject({
      provider: "Greenhouse",
      externalId: "44444",
      company: "Example Inc.",
      description: "Build secure systems.",
      workType: "Remote",
      jobUrl: "https://boards.greenhouse.io/example/jobs/44444",
    });
    expect(calls).toBe(1);
  });

  it("keeps unknown Lever fields explicit instead of inventing values", async () => {
    const connector = createConnector("Lever", {
      fetchImpl: jsonFetch([
        {
          id: "abc",
          text: "Staff Engineer",
          categories: {},
          descriptionPlain: "Own the platform and its reliability.",
          hostedUrl: "https://jobs.lever.co/example/abc",
          workplaceType: "onsite",
          salaryRange: null,
        },
      ]),
    });
    const query = { board: "example", terms: [], company: "Example Inc." };
    const page = await connector.search(query);
    const raw = await connector.fetchJob(page.jobs[0]);
    const normalized = await connector.normalize(raw, { query });
    expect(normalized).toMatchObject({
      provider: "Lever",
      employmentType: "Unknown",
      workType: "On-site",
      location: "",
      salaryMin: null,
      salaryMax: null,
      salaryPeriod: "unknown",
      currency: "Unknown",
    });
  });

  it("normalizes RemoteOK while skipping its legal metadata record", async () => {
    const connector = createConnector("RemoteOK", {
      fetchImpl: jsonFetch([
        { legal: "RemoteOK API terms" },
        {
          id: 1137388,
          slug: "example-role",
          company: "Example Remote",
          position: "Remote Platform Lead",
          description: "<p>Lead a distributed platform team.</p>",
          location: "Anywhere",
          date: "2026-09-12T16:00:10+00:00",
          url: "https://remoteok.com/remote-jobs/example-role",
          apply_url: "",
          salary_min: 0,
          salary_max: 0,
          tags: ["dev", "full time"],
        },
      ]),
    });
    const query = { board: "remoteok", terms: [] };
    const page = await connector.search(query);
    expect(page.jobs).toHaveLength(1);
    const raw = await connector.fetchJob(page.jobs[0]);
    const normalized = await connector.normalize(raw, { query });
    expect(normalized).toMatchObject({
      provider: "RemoteOK",
      company: "Example Remote",
      workType: "Remote",
      salaryMin: null,
      salaryMax: null,
      salaryPeriod: "unknown",
    });
  });

  it("normalizes a multi-employer Jobicy feed and skips malformed rows", async () => {
    const connector = createConnector("Jobicy", {
      fetchImpl: jsonFetch({
        jobs: [
          {
            id: 2166198,
            url: "https://jobicy.com/jobs/2166198-director-platform",
            jobTitle: "Director, Platform Engineering",
            companyName: "Example Remote",
            jobDescription: "<p>Lead a distributed platform team.</p>",
            jobGeo: "Canada",
            jobIndustry: ["Engineering"],
            jobType: ["Full-Time"],
            pubDate: "2026-09-12T16:00:10+00:00",
            salaryMin: 180000,
            salaryMax: 210000,
            salaryCurrency: "CAD",
            salaryPeriod: "yearly",
          },
          // Missing required title: skipped rather than failing the scan.
          { id: 1, url: "https://jobicy.com/jobs/broken", companyName: "x" },
        ],
      }),
    });
    const query = { board: "jobicy", terms: [] };
    const page = await connector.search(query);
    expect(page.complete).toBe(true);
    expect(page.canMarkRemovals).toBe(false);
    expect(page.jobs).toHaveLength(1);
    const raw = await connector.fetchJob(page.jobs[0]);
    const normalized = await connector.normalize(raw, { query });
    expect(normalized).toMatchObject({
      provider: "Jobicy",
      externalId: "2166198",
      company: "Example Remote",
      description: "Lead a distributed platform team.",
      location: "Canada",
      workType: "Remote",
      employmentType: "Full-time",
      salaryMin: 180000,
      salaryMax: 210000,
      salaryPeriod: "year",
      currency: "CAD",
    });
  });

  it("allows JSON-LD only on configured hosts and normalizes schema data", async () => {
    const connector = createConnector("JSON-LD", {
      jsonLdAllowedHosts: ["example.com"],
      fetchImpl: async () =>
        new Response(
          `<script type="application/ld+json">{"@type":"JobPosting","title":"Director of Engineering","description":"<p>Lead engineering and improve delivery.</p>","url":"https://example.com/careers/director","identifier":"dir-1","datePosted":"2026-09-01","employmentType":"FULL_TIME","hiringOrganization":{"name":"Example Inc."},"jobLocation":{"address":{"addressLocality":"Vancouver","addressRegion":"BC","addressCountry":"CA"}}}</script>`,
        ),
    });
    const query = {
      board: "",
      terms: [],
      company: "Example Inc.",
      sourceUrl: "https://example.com/careers",
    };
    const page = await connector.search(query);
    expect(page.jobs[0].externalId).toBe("dir-1");
    const raw = await connector.fetchJob(page.jobs[0]);
    const normalized = await connector.normalize(raw, { query });
    expect(normalized).toMatchObject({
      provider: "JSON-LD",
      company: "Example Inc.",
      location: "Vancouver, BC",
      country: "CA",
      employmentType: "Full-time",
    });

    const rejected = createConnector("JSON-LD", {
      jsonLdAllowedHosts: ["example.com"],
    });
    await expect(
      rejected.search({
        board: "",
        terms: [],
        sourceUrl: "https://not-example.com/careers",
      }),
    ).rejects.toThrow("not allowlisted");
  });

  it("parses provider names and source retry windows", () => {
    expect(providerName("remoteok")).toBe("RemoteOK");
    expect(providerName("json-ld")).toBe("JSON-LD");
    expect(() => providerName("crawler")).toThrow();
    expect(retryAfterMs("90")).toBe(90000);
    expect(retryAfterMs("not-a-date")).toBeUndefined();
  });

  it("refuses to build a CapturedApi connector before replay is implemented", () => {
    expect(() => createConnector("CapturedApi", {})).toThrow("Not implemented");
  });

  it("sends a captured pattern's method and body through the fetch transport", async () => {
    let seenInit: RequestInit | undefined;
    await fetchText(
      new URL("https://acme.example/api/jobs"),
      { accept: "application/json" },
      {
        method: "POST",
        body: JSON.stringify({ page: 1 }),
        fetchImpl: (async (_url, init) => {
          seenInit = init;
          return new Response("{}");
        }) as typeof fetch,
      },
    );
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.body).toBe(JSON.stringify({ page: 1 }));
  });
});
