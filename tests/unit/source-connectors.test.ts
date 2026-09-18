// tests/unit/source-connectors.test.ts
import { afterEach, describe, expect, it } from "vitest";
import {
  createConnector,
  providerName,
  salaryInt,
  salaryRange,
  type ConnectorOptions,
  type SearchQuery,
} from "@jobfinder/job-sources";

const body = (payload: unknown, status = 200) =>
  ({
    fetchImpl: async () =>
      new Response(
        typeof payload === "string" ? payload : JSON.stringify(payload),
        { status },
      ),
  }) satisfies ConnectorOptions;

const global: SearchQuery = { board: "", terms: ["product"] };
const longText = "Own the roadmap and ship dependable software every week.";

describe("feed salary normalization", () => {
  it("keeps clean magnitudes and rejects anything it would have to guess at", () => {
    expect(salaryInt(120000)).toBe(120000);
    expect(salaryInt("120000")).toBe(120000);
    expect(salaryInt(85500.4)).toBe(85500);
    // The bug class this guards: stripping punctuation turns a range into one number.
    expect(salaryInt("$50-60/hr")).toBeNull();
    expect(salaryInt("85k")).toBeNull();
    expect(salaryInt("100,000 - 120,000")).toBeNull();
    expect(salaryInt(0)).toBeNull();
    expect(salaryInt(20000000)).toBeNull();
    expect(salaryInt(null)).toBeNull();
  });

  it("orders a reversed range instead of failing schema validation", () => {
    expect(salaryRange(90000, 70000)).toEqual({
      salaryMin: 70000,
      salaryMax: 90000,
    });
    expect(salaryRange(null, 70000)).toEqual({
      salaryMin: null,
      salaryMax: 70000,
    });
  });
});

describe("employment type mapping", () => {
  // `permanent` must not mean one thing on one board and another elsewhere, or
  // filtering on employmentType becomes provider-dependent.
  it("stores a permanent contract under one label across connectors", async () => {
    const smart = createConnector("SmartRecruiters", {
      fetchImpl: async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("/postings/1")
              ? {
                  id: "1",
                  name: "Engineer",
                  postingUrl: "https://jobs.smartrecruiters.com/acme/1",
                  company: { name: "Acme" },
                  typeOfEmployment: { label: "Permanent" },
                  jobAd: { sections: { jobDescription: { text: longText } } },
                }
              : {
                  content: [
                    { id: "1", name: "Engineer", company: { name: "Acme" } },
                  ],
                },
          ),
        ),
    });
    const query: SearchQuery = { board: "acme", terms: [], company: "" };
    const page = await smart.search(query);
    const job = await smart.normalize(await smart.fetchJob(page.jobs[0]), {
      query,
    });
    expect(job.employmentType).toBe("Permanent");
  });
});

describe("provider aliases", () => {
  it("resolves every new provider from its stored spelling", () => {
    expect(providerName("workable")).toBe("Workable");
    expect(providerName("Personio")).toBe("Personio");
    expect(providerName("smart-recruiters")).toBe("SmartRecruiters");
    expect(providerName("rippling")).toBe("Rippling");
    expect(providerName("remotive")).toBe("Remotive");
    expect(providerName("the-muse")).toBe("TheMuse");
    expect(providerName("himalayas")).toBe("Himalayas");
    expect(providerName("wwr")).toBe("WeWorkRemotely");
    expect(providerName("usajobs")).toBe("USAJOBS");
    expect(providerName("adzuna")).toBe("Adzuna");
  });
});

describe("global feed connectors", () => {
  it("imports a Remotive listing without inventing a salary", async () => {
    const connector = createConnector(
      "Remotive",
      body({
        jobs: [
          {
            id: 2091129,
            url: "https://remotive.com/remote-jobs/data/senior-data-scientist-2091129",
            title: "Senior Data Scientist",
            company_name: "Lemon.io",
            description: `<p>${longText}</p>`,
            category: "Data and Analytics",
            tags: ["python"],
            job_type: "full_time",
            publication_date: "2026-09-16T12:35:28",
            candidate_required_location: "Europe, APAC",
            // Free text; a parsed magnitude here would be a fabrication.
            salary: "$50-60/hr",
          },
        ],
      }),
    );
    const page = await connector.search(global);
    expect(page.canMarkRemovals).toBe(false);
    expect(page.complete).toBe(true);
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query: global });
    expect(job).toMatchObject({
      provider: "Remotive",
      externalId: "2091129",
      company: "Lemon.io",
      employmentType: "Full-time",
      workType: "Remote",
      location: "Europe, APAC",
      salaryMin: null,
      salaryMax: null,
      salaryPeriod: "unknown",
    });
  });

  it("pages The Muse by page number and stops at the bounded page", async () => {
    const result = (page: number) => ({
      page,
      page_count: 50,
      results: [
        {
          id: 19225596 + page,
          name: "Registered Nurse",
          contents: `<p>${longText}</p>`,
          publication_date: "2025-06-10T09:59:33Z",
          locations: [{ name: "Flexible / Remote" }],
          levels: [{ name: "Mid Level" }],
          categories: [{ name: "Healthcare" }],
          refs: {
            landing_page: `https://www.themuse.com/jobs/example/nurse-${page}`,
          },
          company: { name: "DMC Sinai-Grace Hospital" },
        },
      ],
    });
    let requested = "";
    const connector = createConnector("TheMuse", {
      fetchImpl: async (url) => {
        requested = String(url);
        const page = Number(new URL(String(url)).searchParams.get("page"));
        return new Response(JSON.stringify(result(page)));
      },
    });
    const first = await connector.search(global);
    expect(requested).toContain("page=1");
    expect(first.complete).toBe(false);
    expect(first.next?.cursor).toBe("2");
    expect(first.canMarkRemovals).toBe(false);
    // page_count is 50 but a scan walks only the newest few pages.
    const last = await connector.search(global, { cursor: "5" });
    expect(last.complete).toBe(true);
    expect(last.next).toBeUndefined();
    const raw = await connector.fetchJob(last.jobs[0]);
    const job = await connector.normalize(raw, { query: global });
    expect(job).toMatchObject({
      provider: "TheMuse",
      company: "DMC Sinai-Grace Hospital",
      workType: "Remote",
    });
  });

  it("converts Himalayas Unix timestamps and structured pay", async () => {
    const connector = createConnector(
      "Himalayas",
      body({
        jobs: [
          {
            guid: "https://himalayas.app/companies/hush/jobs/senior-designer",
            applicationLink:
              "https://himalayas.app/companies/hush/jobs/senior-designer",
            title: "Freelance Senior Designer",
            companyName: "HUSH",
            description: `<div>${longText}</div>`,
            employmentType: "Contractor",
            minSalary: 90000,
            maxSalary: 130000,
            currency: "USD",
            salaryPeriod: "annual",
            locationRestrictions: ["United States"],
            categories: ["Creative", "Design"],
            pubDate: 1789736848,
          },
        ],
      }),
    );
    const page = await connector.search(global);
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query: global });
    expect(job).toMatchObject({
      provider: "Himalayas",
      company: "HUSH",
      employmentType: "Contract",
      salaryMin: 90000,
      salaryMax: 130000,
      salaryPeriod: "year",
      currency: "USD",
      location: "United States",
    });
    expect(job.postedAt).toBe(new Date(1789736848 * 1000).toISOString());
  });

  it("splits We Work Remotely titles and refuses a listing with no employer", async () => {
    const item = (title: string) => `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><item>
        <title>${title}</title>
        <region>Anywhere in the World</region>
        <country></country>
        <category>Design</category>
        <type>Contract</type>
        <description>&lt;p&gt;${longText}&lt;/p&gt;</description>
        <pubDate>Fri, 18 Sep 2026 13:04:25 +0000</pubDate>
        <guid>https://weworkremotely.com/remote-jobs/shopify-developer</guid>
        <link>https://weworkremotely.com/remote-jobs/shopify-developer</link>
      </item></channel></rss>`;
    const connector = createConnector(
      "WeWorkRemotely",
      body(item("Sanctuary Computer: Senior Shopify Developer")),
    );
    const page = await connector.search(global);
    expect(page.jobs).toHaveLength(1);
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query: global });
    expect(job).toMatchObject({
      provider: "WeWorkRemotely",
      company: "Sanctuary Computer",
      title: "Senior Shopify Developer",
      employmentType: "Contract",
      workType: "Remote",
      location: "Anywhere in the World",
    });

    const unnamed = createConnector(
      "WeWorkRemotely",
      body(item("Senior Shopify Developer")),
    );
    const other = await unnamed.search(global);
    const rawUnnamed = await unnamed.fetchJob(other.jobs[0]);
    await expect(
      unnamed.normalize(rawUnnamed, { query: global }),
    ).rejects.toThrow(/employer separator/);
  });
});

describe("employer board connectors", () => {
  const board: SearchQuery = { board: "blueground", terms: [], company: "" };

  it("reads a Workable account in one request and carries its name", async () => {
    let calls = 0;
    const connector = createConnector("Workable", {
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            name: "Blueground",
            jobs: [
              {
                shortcode: "186545F8C1",
                title: "Client Experience Coordinator",
                description: `<p>${longText}</p>`,
                url: "https://apply.workable.com/j/186545F8C1",
                employment_type: "Full-time",
                telecommuting: false,
                city: "Athens",
                state: "Attica",
                country: "Greece",
                industry: "Real Estate",
                published_on: "2026-02-12",
              },
            ],
          }),
        );
      },
    });
    const page = await connector.search(board);
    expect(page.complete).toBe(true);
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query: board });
    expect(job).toMatchObject({
      provider: "Workable",
      externalId: "186545F8C1",
      company: "Blueground",
      location: "Athens, Attica, Greece",
      employmentType: "Full-time",
      workType: "On-site",
    });
    // One request returns the board with descriptions; no per-job fetch.
    expect(calls).toBe(1);
  });

  it("joins Personio description sections and builds the job URL from the board", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <workzag-jobs><position>
        <id>1822268</id>
        <office>Munich</office>
        <occupationCategory>other</occupationCategory>
        <name>Backend Engineer</name>
        <jobDescriptions>
          <jobDescription>
            <name>Your tasks</name>
            <value><![CDATA[<p>${longText}</p>]]></value>
          </jobDescription>
          <jobDescription>
            <name>Your profile</name>
            <value><![CDATA[<p>Five years of backend experience.</p>]]></value>
          </jobDescription>
        </jobDescriptions>
        <employmentType>permanent</employmentType>
        <schedule>full-time</schedule>
        <createdAt>2017-03-16T16:25:09+00:00</createdAt>
      </position></workzag-jobs>`;
    const query: SearchQuery = { board: "demo", terms: [], company: "Demo AG" };
    const connector = createConnector("Personio", body(xml));
    const page = await connector.search(query);
    expect(page.jobs[0].url).toBe("https://demo.jobs.personio.de/job/1822268");
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query });
    expect(job).toMatchObject({
      provider: "Personio",
      externalId: "1822268",
      company: "Demo AG",
      employmentType: "Permanent",
      location: "Munich",
    });
    expect(job.description).toBe(
      `Your tasks\n${longText}\n\nYour profile\nFive years of backend experience.`,
    );
  });

  it("reports zero jobs for a Personio board with no openings", async () => {
    const query: SearchQuery = { board: "demo", terms: [], company: "Demo AG" };
    const connector = createConnector(
      "Personio",
      body(`<?xml version="1.0"?><workzag-jobs></workzag-jobs>`),
    );
    const page = await connector.search(query);
    expect(page.jobs).toEqual([]);
    expect(page.complete).toBe(true);
  });

  it("reports zero jobs for an empty We Work Remotely channel", async () => {
    const connector = createConnector(
      "WeWorkRemotely",
      body(`<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`),
    );
    const page = await connector.search(global);
    expect(page.jobs).toEqual([]);
    expect(page.complete).toBe(true);
  });

  it("accepts a Personio careers hostname and refuses any other host", async () => {
    const requested: string[] = [];
    const connector = createConnector("Personio", {
      fetchImpl: async (url) => {
        requested.push(String(url));
        return new Response(
          `<?xml version="1.0"?><workzag-jobs></workzag-jobs>`,
        );
      },
    });
    await connector.search({
      board: "demo.jobs.personio.com",
      terms: [],
      company: "Demo AG",
    });
    expect(requested).toEqual(["https://demo.jobs.personio.com/xml"]);

    // `board` is user input, so a bare hostname must never become the request
    // host: that would turn a source into an outbound GET against any server.
    for (const board of [
      "example.com",
      "attacker.test",
      "evil.com/a?x=",
      "demo.jobs.personio.de.attacker.test",
      "demo.jobs.evil.com",
    ]) {
      await expect(
        connector.search({ board, terms: [], company: "Probe" }),
      ).rejects.toThrow(/subdomain or a jobs\.personio/);
    }
    expect(requested).toHaveLength(1);
  });

  it("pages SmartRecruiters and reads the description from the posting detail", async () => {
    const query: SearchQuery = {
      board: "smartrecruiters",
      terms: [],
      company: "",
    };
    const urls: string[] = [];
    const connector = createConnector("SmartRecruiters", {
      fetchImpl: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("/postings/744000148454651")) {
          return new Response(
            JSON.stringify({
              id: "744000148454651",
              name: "Data Operations Consultant",
              postingUrl:
                "https://jobs.smartrecruiters.com/smartrecruiters/744000148454651-data",
              releasedDate: "2026-09-09T09:43:26.403Z",
              company: { name: "SmartRecruiters Inc" },
              location: { city: "Poland", region: "Remote", remote: true },
              industry: { label: "Computer Software" },
              typeOfEmployment: { label: "Contract" },
              jobAd: {
                sections: {
                  companyDescription: {
                    title: "Company",
                    text: "<p>About us.</p>",
                  },
                  jobDescription: { title: "Job", text: `<p>${longText}</p>` },
                  qualifications: { title: "Skills", text: "<p>SQL.</p>" },
                },
              },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            totalFound: 1,
            content: [
              {
                // The live listing endpoint carries no postingUrl.
                id: "744000148454651",
                name: "Data Operations Consultant",
                company: { name: "SmartRecruiters Inc" },
              },
            ],
          }),
        );
      },
    });
    const page = await connector.search(query);
    expect(urls[0]).toContain("limit=100&offset=0");
    expect(page.complete).toBe(true);
    expect(page.jobs).toEqual([
      {
        externalId: "744000148454651",
        url: "https://jobs.smartrecruiters.com/smartrecruiters/744000148454651",
        board: "smartrecruiters",
        company: "SmartRecruiters Inc",
      },
    ]);
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query });
    expect(job).toMatchObject({
      provider: "SmartRecruiters",
      company: "SmartRecruiters Inc",
      employmentType: "Contract",
      workType: "Remote",
    });
    // Role body leads; the boilerplate company blurb trails it.
    expect(job.description.startsWith(longText)).toBe(true);
    expect(job.description).toContain("About us.");
  });

  it("fetches Rippling job detail and puts the role before the company blurb", async () => {
    const query: SearchQuery = { board: "rippling", terms: [], company: "" };
    const uuid = "75ad50c6-778f-42ee-9c63-70d1cd687202";
    const connector = createConnector("Rippling", {
      fetchImpl: async (url) => {
        if (String(url).endsWith(uuid))
          return new Response(
            JSON.stringify({
              uuid,
              name: "Account Executive",
              url: `https://ats.rippling.com/rippling/jobs/${uuid}`,
              companyName: "Rippling",
              description: {
                company: "<p>About Rippling.</p>",
                role: `<p>${longText}</p>`,
              },
              employmentType: {
                label: "SALARIED_FT",
                id: "Salaried, full-time",
              },
              department: { label: "Sales" },
              workLocations: ["Austin, TX"],
              createdOn: "2026-08-13T08:54:48.317000-07:00",
              payRangeDetails: [],
            }),
          );
        return new Response(
          JSON.stringify([
            {
              uuid,
              name: "Account Executive",
              url: `https://ats.rippling.com/rippling/jobs/${uuid}`,
            },
          ]),
        );
      },
    });
    const page = await connector.search(query);
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query });
    expect(job).toMatchObject({
      provider: "Rippling",
      externalId: uuid,
      company: "Rippling",
      employmentType: "Full-time",
      location: "Austin, TX",
      workType: "On-site",
      salaryMin: null,
      salaryMax: null,
    });
    expect(job.description.startsWith(longText)).toBe(true);
  });
});

const conditionalBoards: [string, SearchQuery][] = [
  ["Workable", { board: "blueground", terms: [], company: "" }],
  ["Personio", { board: "demo", terms: [], company: "Demo AG" }],
];

describe("conditional requests", () => {
  // scan.ts treats a scan as complete when notModified is set and skips removal
  // marking; without it an empty page would deactivate every listing on the
  // board, so both halves of this contract are pinned here.
  it.each(conditionalBoards)(
    "reuses an unchanged %s board",
    async (provider, query) => {
      let sent: Record<string, string> = {};
      const connector = createConnector(provider as never, {
        fetchImpl: async (_url, init) => {
          sent = (init?.headers ?? {}) as Record<string, string>;
          return new Response(null, { status: 304 });
        },
      });
      const page = await connector.search(query, {
        etag: '"v1"',
        lastModified: "Wed, 17 Sep 2026 10:00:00 GMT",
      });
      expect(sent["If-None-Match"]).toBe('"v1"');
      expect(sent["If-Modified-Since"]).toBe("Wed, 17 Sep 2026 10:00:00 GMT");
      expect(page).toMatchObject({
        jobs: [],
        complete: true,
        notModified: true,
      });
    },
  );

  it.each(conditionalBoards)(
    "carries %s validators forward for the next scan",
    async (provider, query) => {
      const connector = createConnector(provider as never, {
        fetchImpl: async () =>
          new Response(
            provider === "Workable"
              ? JSON.stringify({ name: "Blueground", jobs: [] })
              : `<?xml version="1.0"?><workzag-jobs></workzag-jobs>`,
            {
              headers: {
                etag: '"v2"',
                "last-modified": "Thu, 18 Sep 2026 10:00:00 GMT",
              },
            },
          ),
      });
      const page = await connector.search(query);
      expect(page.next).toMatchObject({
        etag: '"v2"',
        lastModified: "Thu, 18 Sep 2026 10:00:00 GMT",
      });
    },
  );
});

describe("credentialed feed connectors", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("names the missing USAJOBS variables instead of scanning", async () => {
    delete process.env.USAJOBS_API_KEY;
    delete process.env.USAJOBS_EMAIL;
    const connector = createConnector("USAJOBS", body({}));
    await expect(connector.search(global)).rejects.toThrow(
      /USAJOBS_API_KEY and USAJOBS_EMAIL/,
    );
  });

  it("authenticates USAJOBS on the registered address and decodes pay intervals", async () => {
    process.env.USAJOBS_API_KEY = "test-key";
    process.env.USAJOBS_EMAIL = "bot@example.com";
    let sent: Record<string, string> = {};
    const connector = createConnector("USAJOBS", {
      fetchImpl: async (_url, init) => {
        sent = (init?.headers ?? {}) as Record<string, string>;
        return new Response(
          JSON.stringify({
            SearchResult: {
              SearchResultItems: [
                {
                  MatchedObjectId: "830216800",
                  MatchedObjectDescriptor: {
                    PositionTitle: "Data Scientist",
                    PositionURI: "https://www.usajobs.gov/job/830216800",
                    PositionLocationDisplay: "Washington, District of Columbia",
                    OrganizationName: "Census Bureau",
                    DepartmentName: "Department of Commerce",
                    JobCategory: [{ Name: "Mathematical Statistics" }],
                    PositionSchedule: [{ Name: "Full-time" }],
                    QualificationSummary: longText,
                    PositionRemuneration: [
                      {
                        MinimumRange: "99200",
                        MaximumRange: "128956",
                        RateIntervalCode: "PA",
                      },
                    ],
                    PublicationStartDate: "2026-09-02",
                    UserArea: { Details: { JobSummary: longText } },
                  },
                },
              ],
            },
          }),
        );
      },
    });
    const page = await connector.search(global);
    expect(sent["User-Agent"]).toBe("bot@example.com");
    expect(sent["Authorization-Key"]).toBe("test-key");
    expect(page.canMarkRemovals).toBe(false);
    const raw = await connector.fetchJob(page.jobs[0]);
    const job = await connector.normalize(raw, { query: global });
    expect(job).toMatchObject({
      provider: "USAJOBS",
      company: "Census Bureau",
      country: "United States",
      salaryMin: 99200,
      salaryMax: 128956,
      salaryPeriod: "year",
      currency: "USD",
      employmentType: "Full-time",
    });
  });

  it("names the missing Adzuna variables instead of scanning", async () => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    const connector = createConnector("Adzuna", body({}));
    await expect(connector.search(global)).rejects.toThrow(
      /ADZUNA_APP_ID and ADZUNA_APP_KEY/,
    );
  });

  it("drops an Adzuna salary the provider predicted rather than storing it", async () => {
    process.env.ADZUNA_APP_ID = "id";
    process.env.ADZUNA_APP_KEY = "key";
    process.env.ADZUNA_COUNTRY = "gb";
    const listing = (predicted: string) => ({
      results: [
        {
          id: 5378229412,
          title: "Product Manager",
          description: longText,
          redirect_url: "https://www.adzuna.co.uk/details/5378229412",
          created: "2026-09-15T08:12:44Z",
          company: { display_name: "Example Ltd" },
          location: { display_name: "London, UK" },
          category: { label: "IT Jobs" },
          contract_time: "full_time",
          contract_type: "permanent",
          salary_min: 70000,
          salary_max: 90000,
          salary_is_predicted: predicted,
        },
      ],
    });
    const guessed = createConnector("Adzuna", body(listing("1")));
    const guessedPage = await guessed.search(global);
    const guessedJob = await guessed.normalize(
      await guessed.fetchJob(guessedPage.jobs[0]),
      { query: global },
    );
    expect(guessedJob).toMatchObject({
      provider: "Adzuna",
      salaryMin: null,
      salaryMax: null,
      salaryPeriod: "unknown",
      currency: "GBP",
    });

    const stated = createConnector("Adzuna", body(listing("0")));
    const statedPage = await stated.search(global);
    const statedJob = await stated.normalize(
      await stated.fetchJob(statedPage.jobs[0]),
      { query: global },
    );
    expect(statedJob).toMatchObject({
      salaryMin: 70000,
      salaryMax: 90000,
      salaryPeriod: "year",
      employmentType: "Permanent",
    });
  });
});

describe("ATS host detection for the new boards", () => {
  const detect = async (href: string) => {
    const { detectAts } = await import("@jobfinder/discovery");
    return detectAts({
      finalUrl: new URL("https://example.com/careers"),
      chain: [],
      html: `<a href="${href}">Careers</a>`,
    });
  };

  it("reads the account slug from a Workable careers link", async () => {
    await expect(
      detect("https://apply.workable.com/blueground/"),
    ).resolves.toEqual({ ats: "Workable", key: "blueground" });
  });

  it("ignores a Workable link that identifies only one posting", async () => {
    await expect(
      detect("https://apply.workable.com/j/186545F8C1"),
    ).resolves.toBeNull();
  });

  it("reads the subdomain from a Personio careers host", async () => {
    await expect(detect("https://demo.jobs.personio.de/")).resolves.toEqual({
      ats: "Personio",
      key: "demo",
    });
    await expect(detect("https://demo.jobs.personio.com/")).resolves.toEqual({
      ats: "Personio",
      key: "demo",
    });
  });

  it("reads the board slug from a Rippling careers link", async () => {
    await expect(
      detect("https://ats.rippling.com/rippling/jobs"),
    ).resolves.toEqual({ ats: "Rippling", key: "rippling" });
  });
});
