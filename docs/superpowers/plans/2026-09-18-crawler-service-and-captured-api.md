# Crawler Service and Captured-API Rung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two cheapest fallback rungs of the retrieval ladder reachable by building the Playwright crawler service and the captured-API connector, so a company with no ATS and no JSON-LD is read by a browser instead of going straight to paid AI extraction.

**Architecture:** Playwright runs in `apps/crawler`, a separate HTTP service with no database credentials, spoken to over a Zod-validated protocol that already exists in `@jobfinder/shared`. The worker resolves a company down the ladder `ats → json-ld → captured-api → browser → ai`; the browser rung is a `SourceConnector` like every other, so `packages/automation/src/scan.ts` stays the only import path.

**Tech Stack:** TypeScript strict, ESM, Node 22+ (CI Node 24), Zod 4, Drizzle, pg-boss 12, Playwright 1.63 (`playwright` in the crawler, `@playwright/test` for tests), Vitest 5, Express-free `node:http`.

**Spec:** [`docs/superpowers/specs/2026-09-18-crawler-service-and-captured-api-design.md`](../specs/2026-09-18-crawler-service-and-captured-api-design.md), which is a delta against [`docs/superpowers/specs/2026-09-15-company-import-and-adaptive-scraping-design.md`](../specs/2026-09-15-company-import-and-adaptive-scraping-design.md). Read both. The 2026-09-15 document is cited below as `design.md`.

## Global Constraints

Every task's requirements implicitly include this section.

- TypeScript strict throughout. No `any`. Validate every external boundary with Zod: request bodies, crawler responses, captured JSON, environment.
- `packages/*`, `apps/worker` and `apps/crawler` never import Next.js.
- `packages/discovery` depends on `@jobfinder/job-sources`, **never the reverse**. A helper needed by both goes in `@jobfinder/shared`.
- `apps/crawler` never imports `@jobfinder/db` and receives no `DATABASE_URL`.
- Outbound user agent is `JobFinder/1.0`; the robots group token is `JobFinder` via `discoveryAgentToken`. Never introduce a token matching `/bot|crawler|spider|curl/i` — Akamai Bot Manager resets the connection for those before responding, which turns a refusal into a hang.
- Every refusal is recorded and shown in plain language, never silent: robots, private address, redirect off-host, CAPTCHA, size, time (`design.md:196`).
- Crawler budgets, exactly (`design.md:174`): one session per host at a time, 60 s per session, 2 s minimum between page loads, 20 pages, 500 postings.
- Crawler image `mcr.microsoft.com/playwright:v1.63.0-noble`, runs as non-root, no published port.
- Unit tests live at `tests/unit/**/*.test.ts` (the only glob `vitest.config.ts` includes). Playwright specs live at `tests/e2e/`.
- Green bar for every task: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`.
- E2E runs against the Docker images, not the local build. Rebuild the relevant container before running Playwright or the tests exercise stale code.

## File Structure

**Created:**

| Path                                                  | Responsibility                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/crawler/package.json`                           | Workspace manifest; depends on `playwright`, `zod`, `@jobfinder/shared`, `@jobfinder/discovery` |
| `apps/crawler/Dockerfile`                             | Playwright base image, non-root                                                                 |
| `apps/crawler/src/index.ts`                           | `node:http` server, bearer auth, Zod request validation, error envelope                         |
| `apps/crawler/src/policy.ts`                          | **Pure.** Host allowlist, robots verdict, resource-type blocking, CAPTCHA markers               |
| `apps/crawler/src/session.ts`                         | Only file that touches Playwright: browser lifecycle, budgets, per-host serialisation           |
| `apps/crawler/src/extract.ts`                         | **Pure.** JSON-LD and DOM posting extraction, posting-link scoring, pagination detection        |
| `apps/crawler/src/crawl.ts`                           | `/crawl` algorithm, composing session + extract + policy                                        |
| `apps/crawler/src/capture.ts`                         | `/capture` algorithm: XHR observation and posting-array detection                               |
| `packages/job-sources/src/connectors/captured-api.ts` | Replays a saved `CrawlPatternSpec` page by page                                                 |
| `tests/unit/crawler-policy.test.ts`                   | Policy unit tests, no browser                                                                   |
| `tests/unit/crawler-extract.test.ts`                  | Extraction unit tests against fixture HTML, no browser                                          |
| `tests/fixtures/crawler/*.html`                       | Listing, posting, paginated and CAPTCHA fixtures                                                |
| `tests/e2e/crawler.spec.ts`                           | Service end-to-end against a local fixture site                                                 |

**Modified:**

| Path                                                                     | Change                                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `packages/discovery/src/transport.ts`                                    | Content-type guard in `RobotsCache.load`                                      |
| `packages/shared/src/crawler.ts`                                         | Gains `renderTemplate` so both sides can use it                               |
| `packages/discovery/src/patterns.ts`                                     | Re-exports `renderTemplate` from shared instead of defining it                |
| `packages/job-sources/src/index.ts`                                      | `ConnectorOptions.crawlPattern`, `CapturedApi` case, exports                  |
| `packages/automation/src/scan.ts`                                        | Loads the pattern row, passes the crawler client, records verification        |
| `packages/discovery/src/resolver.ts`                                     | Captured-API and browser rungs; `Resolution` widens                           |
| `apps/worker/src/handlers.ts`                                            | Builds the crawler client; writes `crawl_patterns` in the resolve transaction |
| `compose.yaml`, `Dockerfile`, `.env.example`, `.github/workflows/ci.yml` | Crawler service and env                                                       |
| `AGENTS.md`, `README.md`, `doc/architecture.md`, `TODOS.md`              | `apps/crawler` is no longer deferred                                          |

`policy.ts` and `extract.ts` are pure so the rules — where the bugs will be — run under Vitest against fixtures. Playwright is confined to `session.ts`.

---

### Task 1: Robots content-type guard

A `robots.txt` that 301s to an HTML page currently parses as an empty ruleset, which means allow-everything. `www.lululemon.com/robots.txt` does exactly this. The crawler enforces robots before navigation and would inherit the flaw, so it is fixed once here.

**Files:**

- Modify: `packages/discovery/src/transport.ts:31-44`
- Test: `tests/unit/discovery.test.ts`

**Interfaces:**

- Consumes: `RobotsCache`, `discoveryFetch`, `routeFetch`, `publicHost` (all existing in the test file).
- Produces: no new exports. `RobotsCache.load` now throws `Error` (not `RobotsBlockedError`) for a 200 whose content type is neither absent nor `text/plain`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/discovery.test.ts`, inside the existing `describe("Phase 5 discovery transport")` block:

```ts
it("refuses to treat an HTML robots.txt as an empty ruleset", async () => {
  const fetchImpl = routeFetch({
    "https://html-robots.example/robots.txt": () =>
      new Response("<html><body>Shop now</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  const robots = new RobotsCache({ fetchImpl, resolveHost: publicHost });
  await expect(
    robots.check(new URL("https://html-robots.example/careers")),
  ).rejects.toThrow(/unexpected content type/i);
});

it("still accepts a robots.txt served without a content type", async () => {
  const fetchImpl = routeFetch({
    "https://bare-robots.example/robots.txt": () =>
      new Response("User-agent: *\nDisallow: /private\n", { status: 200 }),
  });
  const robots = new RobotsCache({ fetchImpl, resolveHost: publicHost });
  const check = await robots.check(
    new URL("https://bare-robots.example/careers"),
  );
  expect(check.robotsAllowed).toBe(true);
});
```

Note: `routeFetch` builds `new Response(...)` without a content type in the second case, but `Response` defaults `content-type` to `text/plain;charset=UTF-8` for a string body. That still satisfies the guard, and the test documents the intent.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/discovery.test.ts -t "HTML robots"`
Expected: FAIL — the check resolves with `robotsAllowed: true` instead of throwing.

- [ ] **Step 3: Write minimal implementation**

In `packages/discovery/src/transport.ts`, inside `RobotsCache.load`, replace `if (response.ok) return parseRobots(text);` with:

```ts
if (response.ok) {
  // A robots.txt that redirects to a storefront homepage arrives here as
  // HTML. Parsing it yields an empty ruleset, which reads as allow-all —
  // the opposite of the safe answer for a policy we could not verify.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/^\s*text\/plain\b/i.test(contentType))
    throw new Error(
      `Cannot verify robots.txt for ${host}: unexpected content type ${contentType}.`,
    );
  return parseRobots(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/discovery/src/transport.ts tests/unit/discovery.test.ts
git commit -m "fix: stop treating an HTML robots.txt as allow-all"
```

---

### Task 2: Captured-API connector

`createConnector`'s `CapturedApi` branch throws today. This task replaces it with a connector that replays a saved `CrawlPatternSpec` page by page over the hardened transport — no browser involved, which is what makes this rung cheaper than `browser`.

`renderTemplate` currently lives in `packages/discovery/src/patterns.ts`, but this connector is in `packages/job-sources`, which must not import `discovery`. The helper is pure and belongs with the `CrawlPatternSpec` contract it serves, so it moves to `@jobfinder/shared` and `patterns.ts` re-exports it.

**Files:**

- Modify: `packages/shared/src/crawler.ts`
- Modify: `packages/discovery/src/patterns.ts:171-173`
- Create: `packages/job-sources/src/connectors/captured-api.ts`
- Modify: `packages/job-sources/src/index.ts:95-98` (`ConnectorOptions`), `:297-299` (`CapturedApi` case), export block at `:309`
- Test: `tests/unit/discovery-connectors.test.ts`

**Interfaces:**

- Consumes: `CrawlPatternSpec`, `PatternFieldMap`, `jsonPointerGet` from `@jobfinder/shared`; `fetchJson`, `ConnectorOptions`, `SourceConnector`, `descriptionDigest`, `isoDate` from `../index`; `canonicalUrl` from `@jobfinder/shared/hash`; `jobInputSchema` from `@jobfinder/shared`.
- Produces:
  - `renderTemplate(template: string, page: number): string` — now exported from `@jobfinder/shared`, still re-exported from `@jobfinder/discovery`.
  - `ConnectorOptions.crawlPattern?: CrawlPatternSpec | null`
  - `createCapturedApiConnector(options?: ConnectorOptions): SourceConnector<Record<string, unknown>>`
  - `capturedExternalId(raw: Record<string, unknown>, fieldMap: PatternFieldMap, base: string): string`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/discovery-connectors.test.ts`:

```ts
import { createConnector, type ConnectorOptions } from "@jobfinder/job-sources";
import type { CrawlPatternSpec } from "@jobfinder/shared";

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

const posting = (id: number) => ({
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
          "1": [posting(1), posting(2)],
          "2": [posting(3)],
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
      options({ fetchImpl: pagedFetch({ "1": [posting(7)] }) }),
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
    const relative = { ...posting(9), absolute_url: "/jobs/9" };
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/discovery-connectors.test.ts -t "CapturedApi connector"`
Expected: FAIL — `Saved-API replay is not available yet; see the captured-API entry in TODOS.md.`

- [ ] **Step 3: Move `renderTemplate` into shared**

Append to `packages/shared/src/crawler.ts`:

```ts
/** Renders a template string by replacing `{page}` with the given number. */
export function renderTemplate(template: string, page: number): string {
  return template.replace(/\{page\}/g, String(page));
}
```

In `packages/discovery/src/patterns.ts`, delete the local `renderTemplate` definition at the end of the file and re-export instead, so existing importers of `@jobfinder/discovery` keep working:

```ts
export { renderTemplate } from "@jobfinder/shared";
```

- [ ] **Step 4: Write the connector**

Create `packages/job-sources/src/connectors/captured-api.ts`:

```ts
import {
  jobInputSchema,
  jsonPointerGet,
  renderTemplate,
  type CrawlPatternSpec,
  type PatternFieldMap,
} from "@jobfinder/shared";
import { canonicalUrl } from "@jobfinder/shared/hash";
import {
  descriptionDigest,
  fetchJson,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const maxPages = 20;
const maxJobs = 500;

const readString = (
  raw: Record<string, unknown>,
  pointer: string | undefined,
): string => {
  if (!pointer) return "";
  const value = jsonPointerGet(raw, pointer);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
};

/** Absolute posting URL, resolved against the pattern's own origin. */
export const capturedUrl = (
  raw: Record<string, unknown>,
  fieldMap: PatternFieldMap,
  base: string,
): string | null => {
  const value = readString(raw, fieldMap.url);
  if (!value) return null;
  try {
    const resolved = new URL(value, base);
    return resolved.protocol === "https:" ? resolved.href : null;
  } catch {
    return null;
  }
};

export const capturedExternalId = (
  raw: Record<string, unknown>,
  fieldMap: PatternFieldMap,
  base: string,
): string =>
  readString(raw, fieldMap.id) ||
  canonicalUrl(capturedUrl(raw, fieldMap, base) ?? base);

/**
 * Fourth rung of the ladder: a JSON request a careers page was seen making,
 * replayed without a browser. Cheaper than a crawl and more reliable than DOM
 * scraping, because the site's own API is the source.
 */
export function createCapturedApiConnector(
  options: ConnectorOptions = {},
): SourceConnector<Record<string, unknown>> {
  const cache = new Map<string, Record<string, unknown>>();
  return {
    name: "CapturedApi",
    async search(query, _cursor, signal) {
      const spec: CrawlPatternSpec | null | undefined = options.crawlPattern;
      if (!spec)
        throw new Error("This source has no saved API pattern to replay");
      cache.clear();
      const transport = { ...options, signal: signal ?? options.signal };
      const jobs: {
        externalId: string;
        url: string;
        sourceUrl: string;
        company?: string;
      }[] = [];
      let complete = true;
      let parsedAny = false;
      let page = 1;
      for (; page <= maxPages && jobs.length < maxJobs; page++) {
        const url = new URL(renderTemplate(spec.urlTemplate, page));
        const { data, status } = await fetchJson(
          url,
          {
            ...transport,
            method: spec.method,
            body: spec.body ? renderTemplate(spec.body, page) : undefined,
          },
          spec.headers,
        );
        if (status !== 200) break;
        const postings = jsonPointerGet(data, spec.jobsPath);
        if (!Array.isArray(postings) || postings.length === 0) break;
        for (const entry of postings) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            continue;
          const raw = entry as Record<string, unknown>;
          const href = capturedUrl(raw, spec.fieldMap, spec.urlTemplate);
          const title = readString(raw, spec.fieldMap.title);
          if (!href || !title) continue;
          parsedAny = true;
          if (jobs.length >= maxJobs) {
            complete = false;
            break;
          }
          const externalId = capturedExternalId(
            raw,
            spec.fieldMap,
            spec.urlTemplate,
          );
          cache.set(externalId, raw);
          jobs.push({
            externalId,
            url: href,
            sourceUrl: spec.urlTemplate,
            company: query.company,
          });
        }
        // A pattern with no `{page}` placeholder returns the same body forever.
        if (
          !spec.urlTemplate.includes("{page}") &&
          !spec.body?.includes("{page}")
        )
          break;
      }
      if (page > maxPages) complete = false;
      if (!parsedAny)
        throw new Error("Saved API replay returned no parseable posting");
      return { jobs, complete, canMarkRemovals: complete, notModified: false };
    },
    async fetchJob(reference) {
      const cached = cache.get(reference.externalId);
      if (!cached)
        throw new Error(
          "Saved API posting is no longer available in this scan",
        );
      return cached;
    },
    async normalize(raw, context) {
      const spec = options.crawlPattern;
      if (!spec)
        throw new Error("This source has no saved API pattern to replay");
      const company = context.query.company || context.query.board;
      const jobUrl = capturedUrl(raw, spec.fieldMap, spec.urlTemplate);
      if (!jobUrl) throw new Error("Saved API posting has no usable URL");
      const captured = readString(raw, spec.fieldMap.description);
      const description =
        captured.length >= 20
          ? captured
          : `No description was captured for this posting. See the original listing at ${jobUrl}`;
      const location = readString(raw, spec.fieldMap.location);
      const input = jobInputSchema.parse({
        title: readString(raw, spec.fieldMap.title),
        company,
        description,
        location,
        country: "",
        industry: "",
        employmentType: "Unknown",
        seniority: "Unknown",
        workType: /remote/i.test(
          `${readString(raw, spec.fieldMap.title)} ${location}`,
        )
          ? "Remote"
          : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl,
        postedAt: isoDate(readString(raw, spec.fieldMap.postedAt) || null),
      });
      return {
        ...input,
        externalId: capturedExternalId(raw, spec.fieldMap, spec.urlTemplate),
        provider: "CapturedApi" as const,
        sourceUrl: jobUrl,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
```

- [ ] **Step 5: Wire it into the factory**

In `packages/job-sources/src/index.ts`, add to `ConnectorOptions`:

```ts
export interface ConnectorOptions extends TransportOptions {
  jsonLdAllowedHosts?: string[];
  crawlerClient?: CrawlerClient | null;
  /** The saved request a `CapturedApi` source replays. Null means unresolved. */
  crawlPattern?: CrawlPatternSpec | null;
}
```

Import `type CrawlPatternSpec` from `@jobfinder/shared` at the top of the file. Replace the `CapturedApi` throw:

```ts
    case "CapturedApi":
      return createCapturedApiConnector(options);
```

Add `createCapturedApiConnector` to both the import block at `:309` and the export block at `:330`, alongside `createBrowserConnector`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/discovery-connectors.test.ts`
Expected: PASS.

- [ ] **Step 7: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/crawler.ts packages/discovery/src/patterns.ts \
  packages/job-sources/src/connectors/captured-api.ts \
  packages/job-sources/src/index.ts tests/unit/discovery-connectors.test.ts
git commit -m "feat: replay saved API patterns through a CapturedApi connector"
```

---

### Task 3: Scan wiring for patterns and the crawler client

`scan.ts` never reaches the `CapturedApi` or `Browser` branches because it special-cases `Careers` and passes no crawler client. `scanSourceWithDb` has no unit test — it is covered by `tests/e2e/`. So the mapping logic goes into a pure exported helper that _is_ unit-tested, and the database wiring is verified end to end.

**Files:**

- Modify: `packages/automation/src/scan.ts:239-260`
- Modify: `packages/automation/src/index.ts` (export the new helper)
- Test: `tests/unit/automation.test.ts` (pure helper), `tests/e2e/companies.spec.ts` (wiring)

**Interfaces:**

- Consumes: `createConnector`, `crawlerClientFromEnv` from `@jobfinder/job-sources`; `crawlPatterns` from `@jobfinder/db`; `CrawlPatternSpec` from `@jobfinder/shared`.
- Produces: `crawlPatternToSpec(row: CrawlPatternRow | undefined): CrawlPatternSpec | null`, where `CrawlPatternRow = typeof crawlPatterns.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/automation.test.ts`:

```ts
import { crawlPatternToSpec } from "@jobfinder/automation";

describe("crawlPatternToSpec", () => {
  const row = {
    id: "00000000-0000-0000-0000-000000000001",
    sourceId: "00000000-0000-0000-0000-000000000002",
    kind: "http-json",
    urlTemplate: "https://acme.example/api/jobs?page={page}",
    method: "GET",
    headers: { accept: "application/json" },
    body: null,
    jobsPath: "/results",
    fieldMap: { title: "/title", url: "/url" },
    discoveredAt: new Date(),
    lastVerifiedAt: null,
    failures: 0,
  };

  it("maps a stored row onto the wire contract", () => {
    expect(crawlPatternToSpec(row)).toEqual({
      urlTemplate: "https://acme.example/api/jobs?page={page}",
      method: "GET",
      headers: { accept: "application/json" },
      body: null,
      jobsPath: "/results",
      fieldMap: { title: "/title", url: "/url" },
    });
  });

  it("returns null for a missing row", () => {
    expect(crawlPatternToSpec(undefined)).toBeNull();
  });

  it("returns null for a row whose stored method is not replayable", () => {
    expect(crawlPatternToSpec({ ...row, method: "DELETE" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/automation.test.ts -t crawlPatternToSpec`
Expected: FAIL — `crawlPatternToSpec` is not exported from `@jobfinder/automation`.

- [ ] **Step 3: Write the helper**

Add to `packages/automation/src/scan.ts`, above `scanSourceWithDb`:

```ts
export type CrawlPatternRow = typeof crawlPatterns.$inferSelect;

/**
 * The stored row is wider than the wire contract and its `method` is a plain
 * text column, so a row written by an older migration cannot be trusted to
 * hold a replayable verb.
 */
export function crawlPatternToSpec(
  row: CrawlPatternRow | undefined,
): CrawlPatternSpec | null {
  if (!row) return null;
  if (row.method !== "GET" && row.method !== "POST") return null;
  return {
    urlTemplate: row.urlTemplate,
    method: row.method,
    headers: row.headers,
    body: row.body,
    jobsPath: row.jobsPath,
    fieldMap: row.fieldMap,
  };
}
```

Import `crawlPatterns` from `@jobfinder/db` and `type CrawlPatternSpec` from `@jobfinder/shared` at the top of `scan.ts`. Re-export `crawlPatternToSpec` and `CrawlPatternRow` from `packages/automation/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/automation.test.ts -t crawlPatternToSpec`
Expected: PASS.

- [ ] **Step 5: Wire the connector selection**

In `scan.ts`, immediately before the `const connector =` assignment at `:239`, load the pattern:

```ts
const [patternRow] =
  provider === "CapturedApi"
    ? await db
        .select()
        .from(crawlPatterns)
        .where(eq(crawlPatterns.sourceId, sourceId))
    : [];
const crawlPattern = crawlPatternToSpec(patternRow);
if (provider === "CapturedApi" && !crawlPattern)
  throw new AppError(
    409,
    "This source has no saved API pattern. Retry discovery to rebuild it.",
  );
```

Then extend the non-`Careers` branch of the `connector` assignment so both new providers get what they need:

```ts
        : createConnector(provider, {
            ...options.connectorOptions,
            crawlPattern,
            crawlerClient:
              options.connectorOptions?.crawlerClient ?? crawlerClientFromEnv(),
            jsonLdAllowedHosts:
              options.connectorOptions?.jsonLdAllowedHosts ??
              (process.env.JSON_LD_ALLOWED_HOSTS ?? "")
                .split(",")
                .map((host) => host.trim().toLowerCase())
                .filter(Boolean),
          });
```

- [ ] **Step 6: Record pattern health**

In the success path, immediately before the first `return await finishRun(db, run.id, { status: "Succeeded", ...})` at `:391`, add:

```ts
if (patternRow)
  await db
    .update(crawlPatterns)
    .set({ lastVerifiedAt: new Date(), failures: 0 })
    .where(eq(crawlPatterns.id, patternRow.id));
```

In the `catch (error)` block at `:417`, after the `searchRuns` update and before `recordActivity`, add:

```ts
if (patternRow)
  await db
    .update(crawlPatterns)
    .set({ failures: sql`${crawlPatterns.failures} + 1` })
    .where(eq(crawlPatterns.id, patternRow.id));
```

`patternRow` must therefore be declared in the function scope that both blocks can see — hoist its `let` declaration above the `try`. Import `sql` from `drizzle-orm`.

- [ ] **Step 7: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/automation/src/scan.ts packages/automation/src/index.ts \
  tests/unit/automation.test.ts
git commit -m "feat: scan CapturedApi and Browser sources through the crawler client"
```

---

### Task 4: Resolver rungs for captured-API and browser

The resolver stops at `Careers`/`ai`. This inserts the two cheaper rungs ahead of it and, per the spec, degrades to `ai` with a recorded warning when the crawler is absent.

**Files:**

- Modify: `packages/discovery/src/resolver.ts:20-28` (types), `:98-128` (tail)
- Test: `tests/unit/discovery.test.ts`

**Interfaces:**

- Consumes: `CrawlerClient` from `@jobfinder/job-sources`; `buildPatternSpec`, `validatePattern` from `./patterns`.
- Produces:
  - `DiscoveryOptions` gains `crawlerClient?: CrawlerClient | null`.
  - `Resolution.provider` widens to `SupportedAts | "Careers" | "CapturedApi" | "Browser"`.
  - `Resolution.strategy` widens to `"ats" | "json-ld" | "captured-api" | "browser" | "ai"`.
  - `Resolution` gains `pattern?: CrawlPatternSpec` — set only when `strategy === "captured-api"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/discovery.test.ts`:

```ts
import { resolveCompanyWebsite } from "@jobfinder/discovery";

const bareSite = (html: string) =>
  routeFetch({
    "https://plain.example/robots.txt": () =>
      new Response("User-agent: *\nAllow: /\n"),
    "https://plain.example/": () => new Response(html),
  });

const listingHtml = `<html><body><a href="/careers">Careers</a></body></html>`;

describe("resolver crawler rungs", () => {
  const base = {
    resolveHost: publicHost,
    fetchImpl: routeFetch({
      "https://plain.example/robots.txt": () =>
        new Response("User-agent: *\nAllow: /\n"),
      "https://plain.example/": () => new Response(listingHtml),
      "https://plain.example/careers": () =>
        new Response("<html><body>Roles load here</body></html>"),
    }),
  };

  it("prefers a captured API over the browser and the AI rung", async () => {
    const resolution = await resolveCompanyWebsite("https://plain.example/", {
      ...base,
      crawlerClient: {
        crawl: async () => ({ jobs: [], complete: true, warnings: [] }),
        capture: async () => ({
          patterns: [
            {
              url: "https://plain.example/api/jobs?page=1",
              method: "GET" as const,
              headers: { accept: "application/json" },
              body: null,
              jobsPath: "/results",
              sample: [
                { title: "Engineer", url: "https://plain.example/jobs/1" },
              ],
            },
          ],
          warnings: [],
        }),
      },
      validateSpec: async () => ({ ok: true as const, count: 1 }),
    });
    expect(resolution.strategy).toBe("captured-api");
    expect(resolution.provider).toBe("CapturedApi");
    expect(resolution.pattern?.urlTemplate).toBe(
      "https://plain.example/api/jobs?page={page}",
    );
  });

  it("falls back to the browser when nothing can be captured", async () => {
    const resolution = await resolveCompanyWebsite("https://plain.example/", {
      ...base,
      crawlerClient: {
        crawl: async () => ({ jobs: [], complete: true, warnings: [] }),
        capture: async () => ({ patterns: [], warnings: [] }),
      },
    });
    expect(resolution.strategy).toBe("browser");
    expect(resolution.provider).toBe("Browser");
  });

  it("degrades to the AI rung and says so when no crawler is configured", async () => {
    const stages: string[] = [];
    const resolution = await resolveCompanyWebsite("https://plain.example/", {
      ...base,
      crawlerClient: null,
      onProgress: async (stage, message) => {
        stages.push(`${stage}:${message}`);
      },
    });
    expect(resolution.strategy).toBe("ai");
    expect(stages.join("\n")).toMatch(/crawler.*not configured/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/discovery.test.ts -t "resolver crawler rungs"`
Expected: FAIL — every case resolves to `strategy: "ai"`, and `crawlerClient` is not an accepted option.

- [ ] **Step 3: Widen the types**

In `packages/discovery/src/resolver.ts`:

```ts
export interface DiscoveryOptions extends TransportOptions {
  onProgress?: (stage: string, message: string) => Promise<void>;
  /** Null means the browser rung is unavailable; the resolver says so. */
  crawlerClient?: CrawlerClient | null;
  /** Injected in tests so pattern validation does not need a live replay. */
  validateSpec?: typeof validatePattern;
}

export interface Resolution {
  careersUrl: string;
  provider: SupportedAts | "Careers" | "CapturedApi" | "Browser";
  board: string;
  strategy: "ats" | "json-ld" | "captured-api" | "browser" | "ai";
  ats: string | null;
  policy: PolicyCheck;
  /** Present only for `captured-api`; the caller persists it. */
  pattern?: CrawlPatternSpec;
}
```

Import `type CrawlerClient` from `@jobfinder/job-sources`, `type CrawlPatternSpec` from `@jobfinder/shared`, and `buildPatternSpec`, `validatePattern` from `./patterns`.

- [ ] **Step 4: Insert the rungs**

Replace the tail of `resolveCompanyWebsite` — everything from `const structured = extractJsonLdJobs(page.text).length > 0;` to the final `return` — with:

```ts
const structured = extractJsonLdJobs(page.text).length > 0;
if (structured) {
  await options.onProgress?.(
    "strategy",
    "Structured job listings found. Reading those before using AI.",
  );
  return {
    careersUrl: page.finalUrl.href,
    provider: "Careers",
    board: input.hostname,
    strategy: "json-ld",
    ats: detection?.ats ?? null,
    policy,
  };
}

const detected = detection
  ? `${detection.ats} detected without a supported API connector. `
  : "No supported job API detected. ";
const crawler = options.crawlerClient;
if (!crawler) {
  await options.onProgress?.(
    "strategy",
    `${detected}The crawler service is not configured, so the cheaper captured-API and browser rungs were skipped. Using careers-page extraction with an AI fallback.`,
  );
  return {
    careersUrl: page.finalUrl.href,
    provider: "Careers",
    board: input.hostname,
    strategy: "ai",
    ats: detection?.ats ?? null,
    policy,
  };
}

const validate = options.validateSpec ?? validatePattern;
try {
  await options.onProgress?.(
    "capture",
    "Watching the careers page for a job API it calls.",
  );
  const captured = await crawler.capture(
    { url: page.finalUrl.href },
    options.signal,
  );
  for (const candidate of captured.patterns) {
    const spec = buildPatternSpec(candidate);
    if (!spec) continue;
    const verdict = await validate(spec, options);
    if (!verdict.ok) continue;
    await options.onProgress?.(
      "strategy",
      `Saved the job API this page calls; ${verdict.count} postings replayed without a browser.`,
    );
    return {
      careersUrl: page.finalUrl.href,
      provider: "CapturedApi",
      board: input.hostname,
      strategy: "captured-api",
      ats: detection?.ats ?? null,
      policy,
      pattern: spec,
    };
  }
  await options.onProgress?.(
    "strategy",
    `${detected}No replayable job API was found, so this board will be read with a browser.`,
  );
  return {
    careersUrl: page.finalUrl.href,
    provider: "Browser",
    board: input.hostname,
    strategy: "browser",
    ats: detection?.ats ?? null,
    policy,
  };
} catch (error) {
  // An unreachable or failing crawler must not cost a company its
  // resolution: the AI rung already handles this page today.
  await options.onProgress?.(
    "strategy",
    `${detected}The crawler service could not read this page (${
      error instanceof Error ? error.message : "unknown error"
    }), so it falls back to careers-page extraction with AI.`,
  );
  return {
    careersUrl: page.finalUrl.href,
    provider: "Careers",
    board: input.hostname,
    strategy: "ai",
    ats: detection?.ats ?? null,
    policy,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS, including the pre-existing resolver tests.

- [ ] **Step 6: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/discovery/src/resolver.ts tests/unit/discovery.test.ts
git commit -m "feat: resolve companies through the captured-API and browser rungs"
```

---

### Task 5: Worker handler persists the pattern

The resolve handler writes a `job_sources` row from the `Resolution`. A `CapturedApi` source is useless without its pattern, so both rows are written in the same transaction.

**Files:**

- Modify: `apps/worker/src/handlers.ts:238-335`
- Test: `tests/e2e/companies.spec.ts`

**Interfaces:**

- Consumes: `Resolution.pattern` from Task 4; `crawlPatterns` from `@jobfinder/db`; `crawlerClientFromEnv` from `@jobfinder/job-sources`.
- Produces: no new exports.

- [ ] **Step 1: Pass the crawler client into resolution**

In `apps/worker/src/handlers.ts`, change the `resolveCompanyWebsite` call at `:239`:

```ts
const resolution = await resolveCompanyWebsite(
  candidate.websiteUrl ?? `https://${candidate.domain}/`,
  {
    ...options,
    onProgress: progress,
    crawlerClient: options.crawlerClient ?? crawlerClientFromEnv(),
  },
);
```

Add `crawlerClient?: CrawlerClient | null` to the handler's options type so tests can inject a fake, and import `crawlerClientFromEnv` and `type CrawlerClient` from `@jobfinder/job-sources`.

- [ ] **Step 2: Insert the pattern row in the same transaction**

Inside the `db.transaction` block, after the `job_sources` row is upserted and its id is known, add:

```ts
if (resolution.pattern) {
  await tx
    .insert(crawlPatterns)
    .values({
      sourceId: source.id,
      kind: "http-json",
      urlTemplate: resolution.pattern.urlTemplate,
      method: resolution.pattern.method,
      headers: resolution.pattern.headers,
      body: resolution.pattern.body,
      jobsPath: resolution.pattern.jobsPath,
      fieldMap: resolution.pattern.fieldMap,
    })
    .onConflictDoUpdate({
      target: crawlPatterns.sourceId,
      set: {
        urlTemplate: resolution.pattern.urlTemplate,
        method: resolution.pattern.method,
        headers: resolution.pattern.headers,
        body: resolution.pattern.body,
        jobsPath: resolution.pattern.jobsPath,
        fieldMap: resolution.pattern.fieldMap,
        discoveredAt: new Date(),
        lastVerifiedAt: null,
        failures: 0,
      },
    });
}
```

`crawl_patterns` has a unique index on `source_id` (`packages/db/src/schema.ts:395`), so re-resolution replaces the pattern rather than duplicating it. Import `crawlPatterns` from `@jobfinder/db`.

- [ ] **Step 3: Check the strategy mapping**

`atsKey` at `:316` is set only when `strategy === "ats"`, which is still correct. Confirm `resolution.strategy` flows into `companyCandidates.strategy` unchanged and that the column accepts `captured-api` and `browser` — both are already members of `crawlStrategies` in `packages/shared/src/discovery.ts:23-31`, so no migration is needed.

- [ ] **Step 4: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/handlers.ts
git commit -m "feat: persist a captured API pattern with its source"
```

---

### Task 6: Crawler service scaffold and policy

The service's refusal rules are pure functions, so they are written and tested before a browser is ever launched.

**Files:**

- Create: `apps/crawler/package.json`, `apps/crawler/src/index.ts`, `apps/crawler/src/policy.ts`
- Create: `tests/unit/crawler-policy.test.ts`
- Modify: `package.json` (root: add the `crawler` script and the `playwright` dependency)

**Interfaces:**

- Consumes: `parseRobots`, `robotsAllows`, `discoveryAgentToken` from `@jobfinder/discovery`; `crawlRequestSchema`, `captureRequestSchema`, `crawlerErrorSchema` from `@jobfinder/shared`.
- Produces:
  - `hostAllowed(target: URL, origin: URL): boolean`
  - `blockedResource(type: string): boolean`
  - `looksLikeCaptcha(html: string): boolean`
  - `crawlerUserAgent(chromeUserAgent: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/crawler-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  blockedResource,
  crawlerUserAgent,
  hostAllowed,
  looksLikeCaptcha,
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/crawler-policy.test.ts`
Expected: FAIL — cannot resolve `apps/crawler/src/policy`.

- [ ] **Step 3: Create the workspace manifest**

Create `apps/crawler/package.json`:

```json
{
  "name": "@jobfinder/crawler",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "tsx --env-file-if-exists=../../.env.local src/index.ts"
  }
}
```

Add to the root `package.json` scripts: `"crawler": "npm run start -w @jobfinder/crawler"`. Add `"playwright": "^1.63.0"` to the root `dependencies` (the workspace hoists it; `@playwright/test` stays in `devDependencies`).

- [ ] **Step 4: Write the policy module**

Create `apps/crawler/src/policy.ts`:

```ts
import { registrableDomain, atsHostPattern } from "@jobfinder/discovery";

/**
 * A crawl may follow links within the company's own registrable domain and on
 * to a recognised ATS, and nowhere else. Anything third-party is an advert, a
 * tracker or another company's board.
 */
export function hostAllowed(target: URL, origin: URL): boolean {
  if (target.protocol !== "https:") return false;
  const domain = registrableDomain(origin.hostname);
  if (!domain) return false;
  return (
    registrableDomain(target.hostname) === domain ||
    atsHostPattern.test(target.hostname)
  );
}

const blockedTypes = new Set(["image", "media", "font", "stylesheet"]);

/** A job listing is text. Everything else is bandwidth and fingerprinting. */
export function blockedResource(type: string): boolean {
  return blockedTypes.has(type);
}

const captchaMarkers = [
  /g-recaptcha/i,
  /hcaptcha/i,
  /cf-challenge/i,
  /turnstile/i,
  /verify you are (a )?human/i,
  /are you a robot/i,
  /enable javascript and cookies to continue/i,
];

/**
 * A challenge page ends the session with `kind: "captcha"` and no retry. We do
 * not solve challenges; a site presenting one has declined automated access.
 */
export function looksLikeCaptcha(html: string): boolean {
  return captchaMarkers.some((marker) => marker.test(html));
}

/**
 * Chromium's own user agent with our product token appended. `HeadlessChrome`
 * is rewritten to `Chrome` because edges reject the headless token on sight,
 * and no `bot`-shaped token is introduced: Akamai Bot Manager resets the
 * connection for those before responding, turning a refusal into a hang.
 */
export function crawlerUserAgent(chromeUserAgent: string): string {
  return `${chromeUserAgent.replace(/HeadlessChrome/g, "Chrome")} JobFinder/1.0`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/crawler-policy.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the HTTP server**

Create `apps/crawler/src/index.ts`:

```ts
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  captureRequestSchema,
  crawlRequestSchema,
  type CrawlerError,
} from "@jobfinder/shared";

const port = Number(process.env.PORT ?? 4000);
const secret = process.env.CRAWLER_SECRET?.trim();
if (!secret) throw new Error("CRAWLER_SECRET is required. See README.md.");

function log(level: "info" | "error", event: string, detail: object = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...detail,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Constant-time compare so the secret cannot be guessed byte by byte. */
function authorised(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret!);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

const readBody = (stream: NodeJS.ReadableStream, limit = 64 * 1024) =>
  new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) reject(new Error("Request body too large"));
      else chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const fail = (status: number, error: string, kind: CrawlerError["kind"]) =>
    send(status, { error, kind });

  try {
    if (req.method !== "POST") return fail(405, "Use POST", "internal");
    if (!authorised(req.headers.authorization))
      return fail(401, "Bearer token required", "internal");

    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "Request body must be JSON", "internal");
    }

    if (req.url === "/crawl") {
      const parsed = crawlRequestSchema.safeParse(body);
      if (!parsed.success)
        return fail(400, "Invalid crawl request", "internal");
      const { runCrawl } = await import("./crawl");
      return send(200, await runCrawl(parsed.data));
    }
    if (req.url === "/capture") {
      const parsed = captureRequestSchema.safeParse(body);
      if (!parsed.success)
        return fail(400, "Invalid capture request", "internal");
      const { runCapture } = await import("./capture");
      return send(200, await runCapture(parsed.data));
    }
    return fail(404, "Unknown endpoint", "internal");
  } catch (error) {
    const kind: CrawlerError["kind"] =
      error instanceof CrawlerFailure ? error.kind : "internal";
    const message = error instanceof Error ? error.message : "Crawler failed";
    log("error", "crawler.request_failed", { url: req.url, message, kind });
    return fail(kind === "internal" ? 500 : 422, message, kind);
  }
});

server.listen(port, () => log("info", "crawler.listening", { port }));
```

Import `CrawlerFailure` at the top of `index.ts` from its own module, created in the next step — `crawl.ts`, `capture.ts` and `session.ts` all need it, so it cannot live in the server file.

- [ ] **Step 7: Write the failure type and the two stubs**

Create `apps/crawler/src/failure.ts`:

```ts
import type { CrawlerError } from "@jobfinder/shared";

/** Thrown by crawl/capture so the HTTP layer can pick the right `kind`. */
export class CrawlerFailure extends Error {
  constructor(
    message: string,
    public readonly kind: CrawlerError["kind"],
  ) {
    super(message);
    this.name = "CrawlerFailure";
  }
}
```

`index.ts` dynamically imports `./crawl` and `./capture`, which Tasks 8 and 9
write. Create both now so this task typechecks, each containing only:

```ts
import { CrawlerFailure } from "./failure";

export async function runCrawl(): Promise<never> {
  throw new CrawlerFailure("Crawling is not implemented yet", "internal");
}
```

(and the same shape named `runCapture` in `capture.ts`). Tasks 8 and 9 replace
these files wholesale.

- [ ] **Step 8: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/crawler package.json tests/unit/crawler-policy.test.ts
git commit -m "feat: add the crawler service scaffold and its refusal policy"
```

---

### Task 7: Pure posting extraction

Everything the crawler knows about reading a careers page lives here, against HTML strings, so it tests without a browser.

**Files:**

- Create: `apps/crawler/src/extract.ts`
- Create: `tests/unit/crawler-extract.test.ts`
- Create: `tests/fixtures/crawler/listing.html`, `posting.html`, `paginated.html`

**Interfaces:**

- Consumes: `extractJsonLdJobs` from `@jobfinder/job-sources`; `hostAllowed` from `./policy`.
- Produces:
  - `postingLinks(html: string, base: URL): URL[]`
  - `nextPageLink(html: string, base: URL): URL | null`
  - `extractPosting(html: string, url: URL): { title: string; location: string; description: string; postedAt: string | null } | null`

- [ ] **Step 1: Write the fixtures**

Create `tests/fixtures/crawler/listing.html`:

```html
<html>
  <body>
    <h1>Open roles</h1>
    <ul>
      <li><a href="/careers/job/staff-engineer-1234">Staff Engineer</a></li>
      <li><a href="/careers/job/designer-5678">Product Designer</a></li>
      <li><a href="/about">About us</a></li>
      <li><a href="https://twitter.com/acme">Twitter</a></li>
    </ul>
    <a rel="next" href="/careers?page=2">Next</a>
  </body>
</html>
```

Create `tests/fixtures/crawler/posting.html`:

```html
<html>
  <body>
    <h1>Staff Engineer</h1>
    <span class="job-location">Vancouver, BC</span>
    <div class="job-description">
      <p>You will build the thing and keep it running.</p>
    </div>
  </body>
</html>
```

Create `tests/fixtures/crawler/paginated.html`:

```html
<html>
  <body>
    <a href="/careers/job/one-1">One</a>
    <button>Load more</button>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/crawler-extract.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractPosting,
  nextPageLink,
  postingLinks,
} from "../../apps/crawler/src/extract";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/crawler/${name}`, import.meta.url), "utf8");

describe("crawler extraction", () => {
  const base = new URL("https://acme.example/careers");

  it("keeps posting links and drops navigation and third-party links", () => {
    expect(
      postingLinks(fixture("listing.html"), base).map((u) => u.href),
    ).toEqual([
      "https://acme.example/careers/job/staff-engineer-1234",
      "https://acme.example/careers/job/designer-5678",
    ]);
  });

  it("finds a rel=next pagination link", () => {
    expect(nextPageLink(fixture("listing.html"), base)?.href).toBe(
      "https://acme.example/careers?page=2",
    );
  });

  it("returns null when pagination is a script-driven button", () => {
    expect(nextPageLink(fixture("paginated.html"), base)).toBeNull();
  });

  it("reads a posting from the DOM when there is no JSON-LD", () => {
    const posting = extractPosting(
      fixture("posting.html"),
      new URL("https://acme.example/careers/job/staff-engineer-1234"),
    );
    expect(posting).toMatchObject({
      title: "Staff Engineer",
      location: "Vancouver, BC",
    });
    expect(posting?.description).toContain("build the thing");
  });

  it("prefers JSON-LD over the DOM", () => {
    const html = `<html><body><h1>Wrong title</h1><script type="application/ld+json">
      {"@type":"JobPosting","title":"Right Title","description":"A real description of the role.",
       "datePosted":"2026-09-01","jobLocation":{"address":{"addressLocality":"Remote"}}}
    </script></body></html>`;
    expect(
      extractPosting(html, new URL("https://acme.example/careers/job/x-1")),
    ).toMatchObject({ title: "Right Title", postedAt: "2026-09-01" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/crawler-extract.test.ts`
Expected: FAIL — cannot resolve `apps/crawler/src/extract`.

- [ ] **Step 4: Write the extractor**

Create `apps/crawler/src/extract.ts`:

```ts
import { extractJsonLdJobs } from "@jobfinder/job-sources";
import { hostAllowed } from "./policy";

const anchorPattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

const stripTags = (value: string) =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A posting path carries a slug plus a job word or a numeric id. */
const postingPath =
  /\/(job|jobs|position|positions|opening|openings|role|roles|career|careers|vacancy|vacancies)\b[^?]*\/[^/?]+|\/[^/?]*-\d{3,}/i;

/** Same-host links that look like an individual posting, in document order. */
export function postingLinks(html: string, base: URL): URL[] {
  const seen = new Set<string>();
  const links: URL[] = [];
  anchorPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html))) {
    let href: URL;
    try {
      href = new URL(match[1], base);
    } catch {
      continue;
    }
    href.hash = "";
    if (!hostAllowed(href, base)) continue;
    if (href.href === base.href) continue;
    if (!postingPath.test(href.pathname)) continue;
    if (seen.has(href.href)) continue;
    seen.add(href.href);
    links.push(href);
  }
  return links;
}

const nextMarkers = [/rel=["']next["']/i];

/**
 * Only a real link counts. A `Load more` button is script-driven, and the
 * session clicks it rather than navigating, so it is not a page link.
 */
export function nextPageLink(html: string, base: URL): URL | null {
  anchorPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html))) {
    const tag = match[0];
    const text = stripTags(match[2]).toLowerCase();
    const isNext =
      nextMarkers.some((marker) => marker.test(tag)) || text === "next";
    if (!isNext) continue;
    try {
      const href = new URL(match[1], base);
      href.hash = "";
      if (hostAllowed(href, base) && href.href !== base.href) return href;
    } catch {
      continue;
    }
  }
  return null;
}

const titlePattern = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const locationPattern =
  /<[^>]+(?:class|id|data-[a-z-]+)=["'][^"']*location[^"']*["'][^>]*>([\s\S]*?)<\//i;

/**
 * JSON-LD first, because it is the site's own structured answer. The DOM
 * fallback is deliberately shallow: `h1` plus the longest text block.
 */
export function extractPosting(
  html: string,
  url: URL,
): {
  title: string;
  location: string;
  description: string;
  postedAt: string | null;
} | null {
  const [structured] = extractJsonLdJobs(html);
  if (structured?.title.trim()) {
    return {
      title: structured.title.trim(),
      location: jsonLdLocation(structured),
      description: stripTags(structured.description ?? ""),
      postedAt: structured.datePosted ?? null,
    };
  }
  const title = stripTags(titlePattern.exec(html)?.[1] ?? "");
  if (!title) return null;
  return {
    title,
    location: stripTags(locationPattern.exec(html)?.[1] ?? ""),
    description: stripTags(html).slice(0, 20_000),
    postedAt: null,
  };
}

/**
 * `jobLocation` is `{ address? } | { address? }[] | null` in `jsonLdJobSchema`,
 * and `addressCountry` is either a string or `{ name? }`. Take the first entry.
 */
function jsonLdLocation(job: JsonLdJob): string {
  const location = Array.isArray(job.jobLocation)
    ? job.jobLocation[0]
    : job.jobLocation;
  const address = location?.address;
  if (!address) return "";
  const country =
    typeof address.addressCountry === "string"
      ? address.addressCountry
      : (address.addressCountry?.name ?? "");
  return [address.addressLocality, address.addressRegion, country]
    .filter((value): value is string => !!value?.trim())
    .join(", ");
}
```

`JsonLdJob` is a Zod-inferred type, not a loose record: import it with
`import { extractJsonLdJobs, type JsonLdJob } from "@jobfinder/job-sources";`
and read its fields directly rather than casting through `unknown`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/crawler-extract.test.ts`
Expected: PASS.

- [ ] **Step 6: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/crawler/src/extract.ts tests/unit/crawler-extract.test.ts tests/fixtures/crawler
git commit -m "feat: extract postings and pagination from careers HTML"
```

---

### Task 8: Browser session and the crawl algorithm

The only file that touches Playwright, plus the algorithm that composes it with Task 6's policy and Task 7's extraction.

**Files:**

- Create: `apps/crawler/src/session.ts`, `apps/crawler/src/crawl.ts`
- Test: `tests/e2e/crawler.spec.ts` (Task 10 runs it against Docker; write it here)

**Interfaces:**

- Consumes: `blockedResource`, `crawlerUserAgent`, `hostAllowed`, `looksLikeCaptcha` from `./policy`; `extractPosting`, `nextPageLink`, `postingLinks` from `./extract`; `CrawlerFailure` from `./failure`; `parseRobots`, `robotsAllows`, `discoveryAgentToken` from `@jobfinder/discovery`.
- Produces:
  - `withSession<T>(origin: URL, run: (session: Session) => Promise<T>): Promise<T>`
  - `interface Session { open(url: URL): Promise<string> }`
  - `runCrawl(input: CrawlRequest): Promise<CrawlResponse>`

- [ ] **Step 1: Write the session module**

Create `apps/crawler/src/session.ts`:

```ts
import { chromium, type Browser } from "playwright";
import {
  blockedResource,
  crawlerUserAgent,
  hostAllowed,
  looksLikeCaptcha,
} from "./policy";
import { CrawlerFailure } from "./failure";
import { fetchRobots } from "./robots";

const sessionBudgetMs = 60_000;
const minGapMs = 2_000;

export interface Session {
  /** Navigates and returns settled HTML, or throws a `CrawlerFailure`. */
  open(url: URL): Promise<string>;
}

/** One session per host at a time; a second request for the host waits. */
const hostLocks = new Map<string, Promise<unknown>>();

let shared: Browser | null = null;
async function browser(): Promise<Browser> {
  if (!shared || !shared.isConnected())
    shared = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  return shared;
}

export async function withSession<T>(
  origin: URL,
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const previous = hostLocks.get(origin.hostname) ?? Promise.resolve();
  let release!: () => void;
  hostLocks.set(
    origin.hostname,
    previous.then(() => new Promise<void>((resolve) => (release = resolve))),
  );
  await previous;

  const deadline = Date.now() + sessionBudgetMs;
  const rules = await fetchRobots(origin);
  const context = await (
    await browser()
  ).newContext({
    userAgent: crawlerUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ),
    javaScriptEnabled: true,
    acceptDownloads: false,
    httpCredentials: undefined,
  });
  let lastLoad = 0;
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      let target: URL;
      try {
        target = new URL(request.url());
      } catch {
        return route.abort();
      }
      if (blockedResource(request.resourceType())) return route.abort();
      if (!hostAllowed(target, origin)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const session: Session = {
      async open(url) {
        if (Date.now() > deadline)
          throw new CrawlerFailure("Crawl session budget exhausted", "timeout");
        if (!hostAllowed(url, origin))
          throw new CrawlerFailure(
            `Navigation off-host: ${url.href}`,
            "navigation",
          );
        if (!robotsPermits(rules, url))
          throw new CrawlerFailure(
            `robots.txt disallows ${url.href}`,
            "blocked",
          );
        const wait = minGapMs - (Date.now() - lastLoad);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastLoad = Date.now();
        const response = await page
          .goto(url.href, {
            waitUntil: "domcontentloaded",
            timeout: Math.max(1, Math.min(20_000, deadline - Date.now())),
          })
          .catch((error: Error) => {
            throw new CrawlerFailure(error.message, "navigation");
          });
        if (response && response.status() >= 400)
          throw new CrawlerFailure(
            `HTTP ${response.status()} from ${url.hostname}`,
            response.status() === 403 ? "blocked" : "navigation",
          );
        await page
          .waitForLoadState("networkidle", { timeout: 5_000 })
          .catch(() => {});
        const html = await page.content();
        if (looksLikeCaptcha(html))
          throw new CrawlerFailure(
            "The site presented a challenge page; automated access is declined",
            "captcha",
          );
        return html;
      },
    };
    return await run(session);
  } finally {
    await context.close().catch(() => {});
    release();
  }
}

function robotsPermits(
  rules: Awaited<ReturnType<typeof fetchRobots>>,
  url: URL,
): boolean {
  return rules.allows(`${url.pathname}${url.search}`);
}
```

Create `apps/crawler/src/robots.ts`:

```ts
import {
  discoveryAgentToken,
  discoveryUserAgent,
  parseRobots,
  robotsAllows,
} from "@jobfinder/discovery";
import { CrawlerFailure } from "./failure";

/**
 * The crawler cannot reuse `RobotsCache`: that class is bound to the worker's
 * pinned-DNS transport. The rules and the verdict are the same, and come from
 * the same pure functions, so the two paths cannot drift on interpretation.
 */
export async function fetchRobots(
  origin: URL,
): Promise<{ allows(path: string): boolean }> {
  const response = await fetch(`https://${origin.hostname}/robots.txt`, {
    headers: { "user-agent": discoveryUserAgent, accept: "text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404 || response.status === 410) {
    const empty = parseRobots("");
    return {
      allows: (path) => robotsAllows(empty, path, discoveryAgentToken).allowed,
    };
  }
  if (response.status === 401 || response.status === 403)
    throw new CrawlerFailure(
      `robots.txt for ${origin.hostname} returned HTTP ${response.status}`,
      "blocked",
    );
  if (!response.ok)
    throw new CrawlerFailure(
      `Cannot verify robots.txt for ${origin.hostname}: HTTP ${response.status}`,
      "blocked",
    );
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/^\s*text\/plain\b/i.test(contentType))
    throw new CrawlerFailure(
      `Cannot verify robots.txt for ${origin.hostname}: unexpected content type ${contentType}`,
      "blocked",
    );
  const rules = parseRobots(await response.text());
  return {
    allows: (path) => robotsAllows(rules, path, discoveryAgentToken).allowed,
  };
}
```

The content-type guard mirrors Task 1 deliberately: both paths must refuse an HTML `robots.txt` rather than read it as allow-all.

- [ ] **Step 2: Write the crawl algorithm**

Create `apps/crawler/src/crawl.ts`:

```ts
import {
  crawledJobSchema,
  type CrawlRequest,
  type CrawlResponse,
} from "@jobfinder/shared";
import { extractPosting, nextPageLink, postingLinks } from "./extract";
import { withSession } from "./session";
import { CrawlerFailure } from "./failure";

export async function runCrawl(input: CrawlRequest): Promise<CrawlResponse> {
  const origin = new URL(input.url);
  return withSession(origin, async (session) => {
    const warnings: string[] = [];
    const found = new Map<string, URL>();
    let complete = true;

    let listing: URL | null = origin;
    for (let page = 0; page < input.maxPages && listing; page++) {
      const html = await session.open(listing);
      for (const link of postingLinks(html, listing)) {
        if (found.size >= input.maxJobs) {
          complete = false;
          break;
        }
        found.set(link.href, link);
      }
      if (found.size >= input.maxJobs) break;
      const next: URL | null = nextPageLink(html, listing);
      if (next && page + 1 >= input.maxPages) complete = false;
      listing = next;
    }

    if (found.size === 0)
      throw new CrawlerFailure(
        "No job postings were found on the careers page",
        "navigation",
      );

    const jobs = [];
    for (const url of found.values()) {
      if (jobs.length >= input.maxJobs) {
        complete = false;
        break;
      }
      let html: string;
      try {
        html = await session.open(url);
      } catch (error) {
        if (error instanceof CrawlerFailure && error.kind === "captcha")
          throw error;
        warnings.push(
          `Skipped ${url.href}: ${error instanceof Error ? error.message : "failed"}`,
        );
        complete = false;
        continue;
      }
      const posting = extractPosting(html, url);
      if (!posting) {
        warnings.push(`No readable posting at ${url.href}`);
        complete = false;
        continue;
      }
      jobs.push(
        crawledJobSchema.parse({
          title: posting.title,
          url: url.href,
          location: posting.location,
          description: posting.description,
          postedAt: posting.postedAt,
        }),
      );
    }
    return { jobs, complete, warnings: warnings.slice(0, 50) };
  });
}
```

- [ ] **Step 3: Write the end-to-end spec**

`hostAllowed` refuses anything that is not HTTPS, so the fixture origin must be
served over TLS. Generate a self-signed certificate at test time and let the
browser accept it behind a test-only flag — never a production default.

Add to `session.ts`, in the `newContext` call:

```ts
    // Test-only: the e2e fixture origin uses a self-signed certificate. Never
    // set this in Compose or CI's deployed environment.
    ignoreHTTPSErrors: process.env.CRAWLER_INSECURE_TLS === "1",
```

Create `tests/e2e/crawler.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const crawlerUrl = process.env.CRAWLER_URL ?? "http://localhost:4000";
const secret = process.env.CRAWLER_SECRET ?? "local-development-only";
const auth = {
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
};

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/crawler/${name}`, import.meta.url), "utf8");

/** Self-signed cert for a throwaway HTTPS origin the crawler can reach. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "crawler-e2e-"));
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ]);
  return {
    key: readFileSync(join(dir, "key.pem")),
    cert: readFileSync(join(dir, "cert.pem")),
  };
}

const routes: Record<string, { body: string; type?: string }> = {
  "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
  "/careers": { body: fixture("listing.html") },
  "/careers?page=2": {
    body: "<html><body><a href='/careers/job/third-9012'>Third</a></body></html>",
  },
  "/careers/job/staff-engineer-1234": { body: fixture("posting.html") },
  "/careers/job/designer-5678": { body: fixture("posting.html") },
  "/careers/job/third-9012": { body: fixture("posting.html") },
  "/challenge": {
    body: '<html><body><div class="g-recaptcha"></div></body></html>',
  },
};

test.describe("crawler service", () => {
  let origin = "";
  let server: ReturnType<typeof createServer>;

  test.beforeAll(async () => {
    server = createServer(certificate(), (req, res) => {
      const route = routes[req.url ?? ""];
      if (!route) {
        res.writeHead(404).end("missing");
        return;
      }
      res.writeHead(200, { "content-type": route.type ?? "text/html" });
      res.end(route.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No port");
    origin = `https://host.docker.internal:${address.port}`;
  });

  test.afterAll(() => server.close());

  test("rejects an unauthenticated request", async ({ request }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: { "content-type": "application/json" },
      data: { url: `${origin}/careers` },
    });
    expect(response.status()).toBe(401);
  });

  test("crawls a listing, follows rel=next and returns postings", async ({
    request,
  }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: auth,
      data: { url: `${origin}/careers`, maxPages: 20, maxJobs: 500 },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.jobs.length).toBeGreaterThanOrEqual(3);
    expect(body.jobs[0]).toMatchObject({
      title: "Staff Engineer",
      location: "Vancouver, BC",
    });
    expect(body.complete).toBe(true);
  });

  test("reports an incomplete walk when the page cap is hit", async ({
    request,
  }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: auth,
      data: { url: `${origin}/careers`, maxPages: 1, maxJobs: 500 },
    });
    expect((await response.json()).complete).toBe(false);
  });

  test("ends the session on a challenge page without retrying", async ({
    request,
  }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: auth,
      data: { url: `${origin}/challenge`, maxPages: 20, maxJobs: 500 },
    });
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({ kind: "captcha" });
  });
});
```

The fixture server binds `0.0.0.0` and the origin uses `host.docker.internal`
so the containerised crawler can reach the test process. Add
`extra_hosts: ["host.docker.internal:host-gateway"]` to the `crawler` service in
`compose.yaml` (Task 10) for Linux CI, where that name is not resolvable by
default.

- [ ] **Step 4: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS. The e2e spec runs in Task 10, once the container exists.

- [ ] **Step 5: Commit**

```bash
git add apps/crawler/src/session.ts apps/crawler/src/crawl.ts \
  apps/crawler/src/robots.ts apps/crawler/src/failure.ts tests/e2e/crawler.spec.ts
git commit -m "feat: crawl careers pages in a budgeted browser session"
```

---

### Task 9: API capture

Watches the page's own network traffic for a JSON endpoint that returns postings, which becomes the captured-API pattern and takes the browser out of the loop for every later scan.

**Files:**

- Create: `apps/crawler/src/capture.ts`
- Test: `tests/unit/crawler-extract.test.ts` (the pure detector), `tests/e2e/crawler.spec.ts` (the endpoint)

**Interfaces:**

- Consumes: `withSession` from `./session`; `capturedHeaderAllowlist`, `captureResponseSchema` from `@jobfinder/shared`.
- Produces:
  - `postingArrayPointer(body: unknown): string | null` — exported for unit testing
  - `runCapture(input: { url: string }): Promise<CaptureResponse>`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/crawler-extract.test.ts`:

```ts
import { postingArrayPointer } from "../../apps/crawler/src/capture";

describe("posting array detection", () => {
  it("points at a nested array of postings", () => {
    expect(
      postingArrayPointer({
        data: {
          results: [
            { title: "A", url: "/a" },
            { title: "B", url: "/b" },
          ],
        },
      }),
    ).toBe("/data/results");
  });

  it("accepts a top-level array", () => {
    expect(
      postingArrayPointer([
        { name: "A", absolute_url: "https://x.example/a" },
        { name: "B", absolute_url: "https://x.example/b" },
      ]),
    ).toBe("");
  });

  it("rejects an array of one, and arrays without a title and a URL", () => {
    expect(
      postingArrayPointer({ results: [{ title: "A", url: "/a" }] }),
    ).toBeNull();
    expect(
      postingArrayPointer({ results: [{ colour: "red" }, { colour: "blue" }] }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/crawler-extract.test.ts -t "posting array detection"`
Expected: FAIL — cannot resolve `apps/crawler/src/capture`.

- [ ] **Step 3: Write the capture module**

Create `apps/crawler/src/capture.ts`:

```ts
import {
  capturedHeaderAllowlist,
  captureResponseSchema,
  type CaptureResponse,
} from "@jobfinder/shared";
import { withSession } from "./session";

const titleKey = /title|name|position/i;
const urlKey = /url|link|href|permalink/i;

const looksLikePosting = (entry: unknown): boolean => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const hasTitle = Object.entries(record).some(
    ([key, value]) =>
      titleKey.test(key) && typeof value === "string" && !!value.trim(),
  );
  const hasUrl = Object.entries(record).some(
    ([key, value]) =>
      urlKey.test(key) && typeof value === "string" && !!value.trim(),
  );
  return hasTitle && hasUrl;
};

/**
 * The JSON pointer to the first array of two or more posting-shaped objects.
 * Two is the floor because a one-element array is as likely to be a banner or
 * a featured role as a listing.
 */
export function postingArrayPointer(
  body: unknown,
  pointer = "",
): string | null {
  if (Array.isArray(body))
    return body.length >= 2 && body.every(looksLikePosting) ? pointer : null;
  if (!body || typeof body !== "object") return null;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const found = postingArrayPointer(value, `${pointer}/${escaped}`);
    if (found !== null) return found;
  }
  return null;
}

export async function runCapture(input: {
  url: string;
}): Promise<CaptureResponse> {
  const origin = new URL(input.url);
  const patterns: CaptureResponse["patterns"] = [];
  const warnings: string[] = [];

  await withSession(origin, async (session) => {
    session.onJsonResponse(async (request, body) => {
      if (patterns.length >= 10) return;
      const jobsPath = postingArrayPointer(body);
      if (jobsPath === null) return;
      const sample = (
        jobsPath === ""
          ? (body as Record<string, unknown>[])
          : (pointerGet(body, jobsPath) as Record<string, unknown>[])
      ).slice(0, 3);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (
          capturedHeaderAllowlist.some(
            (allowed) => allowed === key.toLowerCase(),
          )
        )
          headers[key.toLowerCase()] = value;
      }
      patterns.push({
        url: request.url,
        method: request.method,
        headers,
        body: request.body,
        jobsPath,
        sample,
      });
    });
    await session.open(origin);
    await session.settle();
  });

  return captureResponseSchema.parse({
    patterns,
    warnings: warnings.slice(0, 50),
  });
}
```

This requires two additions to `Session` in `apps/crawler/src/session.ts`:

```ts
export interface Session {
  open(url: URL): Promise<string>;
  /** Called for every same-origin JSON response the page receives. */
  onJsonResponse(
    handler: (
      request: {
        url: string;
        method: "GET" | "POST";
        headers: Record<string, string>;
        body: string | null;
      },
      body: unknown,
    ) => Promise<void>,
  ): void;
  /** Resolves once the network has been idle, capped at 20 s (`design.md:146`). */
  settle(): Promise<void>;
}
```

Implement `onJsonResponse` by registering a `page.on("response", ...)` listener that filters to `hostAllowed`, a `content-type` containing `json`, a status of 200 and a body under 4 MB, then `JSON.parse`s it inside a `try`. Implement `settle` as `page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {})`. `pointerGet` is `jsonPointerGet` from `@jobfinder/shared` — import it rather than writing a second one.

Only `GET` and `POST` are representable in `capturedRequestSchema`; skip any other verb rather than coercing it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/crawler-extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the end-to-end spec**

Add to `tests/e2e/crawler.spec.ts`: a fixture page whose script fetches `/api/jobs` returning `{"data":{"results":[…]}}` with two postings, and assert `POST /capture` returns one pattern with `jobsPath: "/data/results"` and headers reduced to the allowlist — specifically that no `cookie` or `authorization` header survives.

- [ ] **Step 6: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/crawler/src/capture.ts apps/crawler/src/session.ts \
  tests/unit/crawler-extract.test.ts tests/e2e/crawler.spec.ts
git commit -m "feat: capture the JSON API a careers page calls"
```

---

### Task 10: Compose, image, environment, CI and documentation

The service exists but nothing runs it. This task makes it real and stops the documentation calling it deferred.

**Files:**

- Create: `apps/crawler/Dockerfile`
- Modify: `compose.yaml`, `Dockerfile`, `.env.example`, `.github/workflows/ci.yml`
- Modify: `AGENTS.md:17`, `README.md`, `doc/architecture.md`, `TODOS.md`

**Interfaces:**

- Consumes: `CRAWLER_URL`, `CRAWLER_SECRET` read by `crawlerClientFromEnv` (Task 3, Task 5).
- Produces: a `crawler` Compose service on the internal network, no published port.

- [ ] **Step 1: Write the crawler image**

Create `apps/crawler/Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/crawler/package.json apps/crawler/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/job-sources/package.json packages/job-sources/package.json
COPY packages/discovery/package.json packages/discovery/package.json
RUN npm ci
COPY . .
USER pwuser
EXPOSE 4000
CMD ["npm", "run", "crawler"]
```

- [ ] **Step 2: Add the Compose service**

Append to `compose.yaml` under the existing `services:` key, alongside `worker`.
The snippet below is shown from the document root so the indentation is
unambiguous — `crawler:` is a sibling of `worker:`, two spaces in:

```yaml
services:
  crawler:
    build:
      context: .
      dockerfile: apps/crawler/Dockerfile
    command: npm run crawler
    env_file:
      - path: .env.local
        required: false
    environment:
      PORT: "4000"
      CRAWLER_SECRET: local-development-only
    # Deliberately no DATABASE_URL and no published port: the crawler runs
    # untrusted pages and must not be able to reach PostgreSQL or the host.
    # host.docker.internal is resolvable on Docker Desktop but not on Linux CI;
    # tests/e2e/crawler.spec.ts serves its fixture origin there.
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
```

Add two variables to the **existing** `worker` service's `environment` block —
do not create a second `environment:` key:

```yaml
services:
  worker:
    environment:
      CRAWLER_URL: http://crawler:4000
      CRAWLER_SECRET: local-development-only
```

Add `apps/crawler/package.json` to the root `Dockerfile`'s `COPY` list so the worker image's `npm ci` still resolves the workspace.

- [ ] **Step 3: Document the environment**

Add to `.env.example`:

```sh
# Browser crawler service. Unset means the captured-API and browser rungs are
# skipped and discovery falls back to AI extraction, with a warning on the
# candidate's activity feed.
CRAWLER_URL=http://crawler:4000
CRAWLER_SECRET=
```

- [ ] **Step 4: Build and run the end-to-end spec**

E2E runs against the Docker images, not the local build, so the containers must be rebuilt or the tests exercise stale code.

Run:

```bash
docker compose build crawler worker web
docker compose up -d
npx playwright test tests/e2e/crawler.spec.ts tests/e2e/companies.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Add CI coverage**

In `.github/workflows/ci.yml`, add `apps/crawler/Dockerfile` to whatever image build matrix exists, and include `tests/e2e/crawler.spec.ts` in the Playwright run. Match the existing job structure rather than inventing a new one.

- [ ] **Step 6: Update the documentation**

- `AGENTS.md:17`: remove `apps/crawler` from the "Not present yet" list and add a bullet describing it alongside the other apps, noting that it holds no database credentials.
- `AGENTS.md`: update the `packages/discovery` bullet, which currently says "browser service/captured API replay remain unfinished".
- `README.md`: document `CRAWLER_URL` and `CRAWLER_SECRET` and the `npm run crawler` script.
- `doc/architecture.md`: describe the five-rung ladder and the crawler's isolation boundary.
- `TODOS.md`: delete the "Captured API connector" and scan-wiring entries, which this plan completes.

- [ ] **Step 7: Full green bar**

Run: `npm run typecheck && npm run lint && npm run format:check && npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/crawler/Dockerfile compose.yaml Dockerfile .env.example \
  .github/workflows/ci.yml AGENTS.md README.md doc/architecture.md TODOS.md
git commit -m "feat: run the crawler service in Compose and CI"
```

---

## Self-review notes

Checked against the spec:

- Ladder order and crawler-down degradation — Task 4.
- Crawler browser identity — Task 6 (`crawlerUserAgent`, with a test asserting no bot token).
- Robots content-type guard — Task 1, reused by the crawler in Task 8 via `apps/crawler/src/robots.ts`.
- Module boundaries, `policy.ts` and `extract.ts` pure — Tasks 6 and 7.
- Data flow, `crawl_patterns` written in the resolve transaction — Task 5.
- Non-goals: no evasion beyond the honest user agent (Task 6), CAPTCHA ends the session with no retry (Task 8), allowlisted headers only (Task 9).
- Testing section: pure unit tests (Tasks 6, 7, 9), fake-`CrawlerClient` tests (Tasks 2, 4), e2e (Tasks 8, 9, 10), robots guard (Task 1).

Two things the spec named that this plan deliberately does **not** do, both flagged in the spec itself:

- The load shape of a 500-row import hitting the browser rung is unmeasured. No task addresses it; measure before a large import.
- `renderTemplate` moving to `@jobfinder/shared` is a dependency-rule consequence the spec did not anticipate. It is folded into Task 2 rather than given its own task, because nothing else depends on it.
