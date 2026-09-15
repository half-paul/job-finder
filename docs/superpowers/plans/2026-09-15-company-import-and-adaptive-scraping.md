# Company Import and Adaptive Scraping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user paste or upload a list of companies; the worker finds each careers page, picks the cheapest permitted retrieval strategy (ATS API, JSON-LD, captured JSON API, Playwright crawl) and imports openings through the existing scan engine and keyword gate.

**Architecture:** Every retrieval strategy is a `SourceConnector`, so `packages/automation/scan.ts` stays the only import path. A new `packages/discovery` package owns the pure resolver ladder (careers URL finder, robots, ATS detector, pattern inference); `packages/automation/companies.ts` persists candidates and applies resolutions. Playwright runs in `apps/crawler`, a separate HTTP service with no database credentials, spoken to through a Zod-validated protocol in `@jobfinder/shared`.

**Tech Stack:** TypeScript strict, Next.js 16 App Router, PostgreSQL 16 + Drizzle, Zod 4, pg-boss 12, Playwright 1.63 (`playwright` package in the crawler, `@playwright/test` for tests), Vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-15-company-import-and-adaptive-scraping-design.md`

## Global Constraints

- Node `>=22`; CI runs Node 24. Prettier formats everything except `AGENTS.md` and the requirements doc (two-space indent, double quotes, semicolons, trailing commas).
- TypeScript `strict`; `@typescript-eslint/no-explicit-any` is an error. Never use `any`; use `unknown` and Zod.
- File names kebab-case. Components/types PascalCase, functions/variables camelCase.
- Validate every external boundary with Zod: request bodies, crawler responses, captured JSON, environment.
- `packages/*` and `apps/worker` and `apps/crawler` never import Next.js. `packages/discovery` depends on `@jobfinder/job-sources`, never the reverse. `apps/crawler` never imports `@jobfinder/db`.
- Transport rules for everything outbound: HTTPS only, DNS resolved once and pinned, non-public addresses rejected, timeouts and byte caps, user agent `JobFinderBot/1.0`. Discovery transport may follow at most 3 redirects, each re-validated. robots.txt is honoured; a disallow is recorded as `Blocked`, never bypassed. No CAPTCHA or login handling.
- Retrieval ladder order is fixed: ATS, then JSON-LD, then captured API, then browser. A run never marks removals unless the walk was complete.
- Keyword gate: `keywordFilter(normalized, settings)` in `scan.ts` applies unchanged to every new provider.
- Unit tests (`tests/unit/**/*.test.ts`) are offline and deterministic: injected `fetchImpl`, fixtures under `tests/fixtures/discovery/`. Real-DB tests live in `tests/e2e/*.spec.ts`, create `@example.test` users and delete them in `finally`. Never scan a live site in a default test run.
- Every new status, refusal and failure is shown to the user in plain language. Nothing pretends to run when the worker or crawler is down.
- Commits: imperative subject, end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Work on branch `feature/phase-5-company-import`.
- Run `npm run lint && npm run typecheck && npm test` before every commit; `npm run format` first.

## File Structure

New:

- `packages/shared/src/discovery.ts` — candidate status/strategy enums, labels, import request schema, `PolicyCheck` type.
- `packages/shared/src/crawler.ts` — crawler HTTP protocol (Zod), `CrawlPatternSpec`, JSON pointer helper, header allowlist.
- `packages/discovery/package.json`, `packages/discovery/src/index.ts` — package entry.
- `packages/discovery/src/seed-list.ts` — paste/CSV parser and registrable domain.
- `packages/discovery/src/robots.ts` — robots.txt parser, `RobotsCache`, `RobotsBlockedError`.
- `packages/discovery/src/transport.ts` — `discoveryFetch` (≤3 redirects, robots gate).
- `packages/discovery/src/careers.ts` — link scorer, probe paths, `findCareersPage`.
- `packages/discovery/src/ats.ts` — `detectAts`.
- `packages/discovery/src/patterns.ts` — `inferFieldMap`, `paginationTemplate`, `validatePattern`.
- `packages/discovery/src/resolve.ts` — `resolveLadder` (pure, injected deps) and `Resolution` type.
- `packages/job-sources/src/crawler-client.ts` — `CrawlerClient` interface, HTTP implementation, env factory.
- `packages/job-sources/src/posting-links.ts` — `collectPostingLinks`.
- `packages/job-sources/src/connectors/careers.ts`, `captured-api.ts`, `browser.ts` — the three connectors.
- `packages/automation/src/companies.ts` — import, list, retry, delete, claim, `applyResolution`, `recordSourceFailure`.
- `apps/web/components/company-import.tsx` — import panel and candidate table.
- `apps/crawler/package.json`, `apps/crawler/Dockerfile`, `apps/crawler/src/index.ts` (HTTP server), `src/policy.ts`, `src/session.ts` (browser launch + route policy), `src/capture.ts`, `src/crawl.ts`, `src/extract.ts`.
- `tests/unit/discovery.test.ts`, `tests/unit/discovery-connectors.test.ts`, `tests/unit/crawler-extract.test.ts`, `tests/e2e/companies.spec.ts`, `tests/e2e/crawler.spec.ts`, fixtures under `tests/fixtures/discovery/`.
- `doc/phase-5-validation.md`.

Modified:

- `packages/db/src/schema.ts` (+ generated `packages/db/drizzle/0006_*.sql`), `packages/shared/src/index.ts`, `packages/job-sources/src/index.ts`, `packages/job-sources/src/transport.ts` (method/body), `packages/job-sources/src/connectors/json-ld.ts` (export extractor and normalizer, extra fields), `packages/job-sources/src/connectors/index.ts`, `packages/automation/src/index.ts`, `packages/automation/src/scan.ts` (pattern + crawler client), `apps/worker/src/queues.ts`, `apps/worker/src/handlers.ts`, `apps/worker/src/index.ts`, `apps/web/app/api/[...path]/route.ts`, `apps/web/lib/automation.ts`, `apps/web/app/(workspace)/watchlist/page.tsx`, `compose.yaml`, `Dockerfile` (copy new package.json files), `.env.example`, `.github/workflows/ci.yml`, `AGENTS.md`, `README.md`, `doc/architecture.md`.

---

### Task 1: Shared contracts for discovery and the crawler protocol

**Files:**

- Create: `packages/shared/src/discovery.ts`
- Create: `packages/shared/src/crawler.ts`
- Modify: `packages/shared/src/index.ts` (add two `export *` lines after `export * from "./keywords";`)
- Test: `tests/unit/discovery.test.ts`

**Interfaces:**

- Produces: `candidateStatuses`, `CandidateStatus`, `crawlStrategies`, `CrawlStrategy`, `detectableAts`, `DetectableAts`, `supportedAts`, `candidateStatusLabel`, `companyImportSchema`, `PolicyCheck`, `httpsUrl`, `crawledJobSchema`/`CrawledJob`, `crawlRequestSchema`, `crawlResponseSchema`/`CrawlResponse`, `captureRequestSchema`, `capturedRequestSchema`/`CapturedRequest`, `captureResponseSchema`/`CaptureResponse`, `crawlerErrorSchema`, `patternFieldMapSchema`/`PatternFieldMap`, `crawlPatternSpecSchema`/`CrawlPatternSpec`, `capturedHeaderAllowlist`, `jsonPointerGet(value: unknown, pointer: string): unknown`, `discoveryProviders`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/discovery.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL, `candidateStatusLabel` is not exported from `@jobfinder/shared`.

- [ ] **Step 3: Write `packages/shared/src/discovery.ts`**

```ts
import { z } from "zod";

/** Where an imported company sits in the resolution ladder. */
export const candidateStatuses = [
  "Pending",
  "Resolving",
  "Resolved",
  "NoCareersPage",
  "Unsupported",
  "Blocked",
  "Failed",
] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

/** Cheapest first. A cheaper rung discovered later replaces a costlier one. */
export const crawlStrategies = [
  "none",
  "ats",
  "json-ld",
  "captured-api",
  "browser",
] as const;
export type CrawlStrategy = (typeof crawlStrategies)[number];

export const detectableAts = [
  "Greenhouse",
  "Lever",
  "Ashby",
  "Workday",
  "SmartRecruiters",
  "iCIMS",
  "Taleo",
] as const;
export type DetectableAts = (typeof detectableAts)[number];

/** Vendors with a connector today. The rest are recorded as Unsupported. */
export const supportedAts = ["Greenhouse", "Lever", "Ashby"] as const;
export type SupportedAts = (typeof supportedAts)[number];
export const isSupportedAts = (value: string): value is SupportedAts =>
  supportedAts.some((ats) => ats === value);

/** Providers the resolver creates; users never add them by hand. */
export const discoveryProviders = [
  "Careers",
  "CapturedApi",
  "Browser",
] as const;
export type DiscoveryProvider = (typeof discoveryProviders)[number];

export const candidateStatusLabel: Record<CandidateStatus, string> = {
  Pending: "Waiting for worker",
  Resolving: "Looking for careers page",
  Resolved: "Resolved",
  NoCareersPage: "No careers page found",
  Unsupported: "Vendor recognised, not yet supported",
  Blocked: "Robots.txt disallows crawling",
  Failed: "Failed",
};

export const strategyLabel: Record<CrawlStrategy, string> = {
  none: "Not resolved",
  ats: "Scanning ATS board",
  "json-ld": "Reading careers page",
  "captured-api": "Replaying saved API",
  browser: "Browser crawl",
};

export const companyImportSchema = z.object({
  text: z.string().max(200_000),
});
export type CompanyImport = z.infer<typeof companyImportSchema>;

/** Recorded before any strategy is enabled; shown to the user, never hidden. */
export interface PolicyCheck {
  robotsAllowed: boolean;
  robotsUrl: string;
  checkedAt: string;
  userAgent: string;
  matchedRule?: string;
}
```

- [ ] **Step 4: Write `packages/shared/src/crawler.ts`**

```ts
import { z } from "zod";

export const httpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((v) => new URL(v).protocol === "https:", "Use an HTTPS URL");

/** One posting as the crawler saw it. Untrusted until the worker validates it. */
export const crawledJobSchema = z.object({
  title: z.string().trim().min(1).max(300),
  url: httpsUrl,
  id: z.string().trim().max(200).optional(),
  location: z.string().trim().max(300).default(""),
  description: z.string().max(50_000).default(""),
  postedAt: z.string().max(64).nullable().default(null),
});
export type CrawledJob = z.infer<typeof crawledJobSchema>;

export const crawlRequestSchema = z.object({
  url: httpsUrl,
  maxPages: z.number().int().min(1).max(20).default(20),
  maxJobs: z.number().int().min(1).max(500).default(500),
});
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;

export const crawlResponseSchema = z.object({
  jobs: z.array(crawledJobSchema).max(500),
  complete: z.boolean(),
  warnings: z.array(z.string().max(500)).max(50),
});
export type CrawlResponse = z.infer<typeof crawlResponseSchema>;

export const captureRequestSchema = z.object({ url: httpsUrl });

/** Request headers a saved pattern may replay. Cookies and auth never qualify. */
export const capturedHeaderAllowlist = [
  "accept",
  "content-type",
  "x-requested-with",
] as const;

export const capturedRequestSchema = z.object({
  url: httpsUrl,
  method: z.enum(["GET", "POST"]),
  headers: z.record(z.string(), z.string().max(500)),
  /** Raw request body text, or null for GET. */
  body: z.string().max(10_000).nullable(),
  /** JSON pointer to the postings array inside the response. */
  jobsPath: z.string().max(200),
  sample: z.array(z.record(z.string(), z.unknown())).min(1).max(3),
});
export type CapturedRequest = z.infer<typeof capturedRequestSchema>;

export const captureResponseSchema = z.object({
  patterns: z.array(capturedRequestSchema).max(10),
  warnings: z.array(z.string().max(500)).max(50),
});
export type CaptureResponse = z.infer<typeof captureResponseSchema>;

export const crawlerErrorKinds = [
  "blocked",
  "timeout",
  "navigation",
  "captcha",
  "internal",
] as const;
export const crawlerErrorSchema = z.object({
  error: z.string().max(1000),
  kind: z.enum(crawlerErrorKinds),
});
export type CrawlerError = z.infer<typeof crawlerErrorSchema>;

/** JSON pointers relative to one posting object. */
export const patternFieldMapSchema = z.object({
  title: z.string().max(200),
  url: z.string().max(200),
  id: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  description: z.string().max(200).optional(),
  postedAt: z.string().max(200).optional(),
});
export type PatternFieldMap = z.infer<typeof patternFieldMapSchema>;

/** A replayable request. `{page}` in the template or body is 1-based. */
export const crawlPatternSpecSchema = z.object({
  urlTemplate: z.string().url().max(2000),
  method: z.enum(["GET", "POST"]),
  headers: z.record(z.string(), z.string().max(500)),
  body: z.string().max(10_000).nullable(),
  jobsPath: z.string().max(200),
  fieldMap: patternFieldMapSchema,
});
export type CrawlPatternSpec = z.infer<typeof crawlPatternSpecSchema>;

/** RFC 6901 lookup. Empty pointer returns the document. */
export function jsonPointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return undefined;
      current = current[index];
    } else if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
```

- [ ] **Step 5: Export from `packages/shared/src/index.ts`**

After the line `export * from "./keywords";` add:

```ts
export * from "./discovery";
export * from "./crawler";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add packages/shared/src tests/unit/discovery.test.ts
git commit -m "Add shared discovery and crawler protocol contracts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Database tables for candidates and saved patterns

**Files:**

- Modify: `packages/db/src/schema.ts` (append after `companyWatchlists`, before `notifications`)
- Create: generated `packages/db/drizzle/0006_*.sql` and meta snapshot via `npm run db:generate`
- Test: `tests/e2e/companies.spec.ts` (first test; extended in Task 11)

**Interfaces:**

- Produces: `companyCandidates`, `crawlPatterns` Drizzle tables. `companyCandidates.policyCheck` is `PolicyCheck | null`; `crawlPatterns.headers` is `Record<string,string>`, `crawlPatterns.fieldMap` is `PatternFieldMap`.

- [ ] **Step 1: Add the tables**

Extend the type import at the top of `packages/db/src/schema.ts`:

```ts
import type {
  Profile,
  Preferences,
  JobMatch,
  PolicyCheck,
  PatternFieldMap,
} from "@jobfinder/shared";
```

Append after the `companyWatchlists` table:

```ts
/**
 * A company the user asked us to import. The worker resolves each candidate
 * once into a strategy and a `job_sources` row; it is not re-resolved until
 * its source fails repeatedly or the user presses Retry.
 */
export const companyCandidates = pgTable(
  "company_candidates",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    watchlistId: uuid("watchlist_id").references(() => companyWatchlists.id, {
      onDelete: "set null",
    }),
    name: text().notNull(),
    /** Registrable domain, lowercase. One candidate per domain per user. */
    domain: text().notNull(),
    origin: text().notNull().default("seed"),
    status: text().notNull().default("Pending"),
    careersUrl: text("careers_url"),
    ats: text(),
    atsKey: text("ats_key"),
    strategy: text().notNull().default("none"),
    sourceId: uuid("source_id").references(() => jobSources.id, {
      onDelete: "set null",
    }),
    policyCheck: jsonb("policy_check").$type<PolicyCheck>(),
    error: text().notNull().default(""),
    attempts: integer().notNull().default(0),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("candidate_owner_domain_unique").on(t.userId, t.domain),
    index("candidate_status_next_idx").on(t.status, t.nextCheckAt),
  ],
);

/** A JSON request the crawler saw a careers page make; refreshes replay it. */
export const crawlPatterns = pgTable(
  "crawl_patterns",
  {
    id: uuid().primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id, { onDelete: "cascade" }),
    kind: text().notNull().default("http-json"),
    urlTemplate: text("url_template").notNull(),
    method: text().notNull().default("GET"),
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    body: text(),
    jobsPath: text("jobs_path").notNull(),
    fieldMap: jsonb("field_map").$type<PatternFieldMap>().notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    failures: integer().notNull().default(0),
  },
  (t) => [uniqueIndex("crawl_pattern_source_unique").on(t.sourceId)],
);
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npm run db:generate` then `docker compose up -d postgres && npm run db:migrate`
Expected: a new `packages/db/drizzle/0006_<name>.sql` creating both tables, and "Database migrations applied."

- [ ] **Step 3: Write the failing real-database test**

```ts
// tests/e2e/companies.spec.ts
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder";
process.env.DATABASE_URL ??= databaseUrl;

test("company candidate and crawl pattern tables exist with their constraints", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('company_candidates','crawl_patterns') ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "company_candidates",
      "crawl_patterns",
    ]);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('candidate_owner_domain_unique','crawl_pattern_source_unique')
       ORDER BY 1`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      "candidate_owner_domain_unique",
      "crawl_pattern_source_unique",
    ]);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 4: Run the test**

Run: `npm run build && npx playwright test tests/e2e/companies.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add packages/db tests/e2e/companies.spec.ts
git commit -m "Add company candidate and crawl pattern tables

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Discovery package scaffold, seed list parser and robots parser

**Files:**

- Create: `packages/discovery/package.json`, `packages/discovery/src/index.ts`, `packages/discovery/src/seed-list.ts`, `packages/discovery/src/robots.ts`
- Modify: `Dockerfile` (add `COPY packages/discovery/package.json packages/discovery/package.json` next to the other package copies)
- Test: `tests/unit/discovery.test.ts` (append)

**Interfaces:**

- Produces: `registrableDomain(host: string): string | null`, `parseSeedList(text: string): { rows: SeedRow[]; rejected: { line: number; reason: string }[] }` with `SeedRow = { name: string; domain: string }`; `parseRobots(text: string): RobotsRules`, `robotsAllows(rules: RobotsRules, path: string, agent: string): { allowed: boolean; matchedRule?: string }`, `class RobotsBlockedError extends Error { constructor(public readonly url: string, public readonly matchedRule: string) }`.

- [ ] **Step 1: Package manifest and entry**

```json
// packages/discovery/package.json
{
  "name": "@jobfinder/discovery",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": "./src/index.ts"
}
```

```ts
// packages/discovery/src/index.ts
export * from "./seed-list";
export * from "./robots";
```

Run `npm install` so the workspace symlink exists. Add the Dockerfile `COPY` line for `packages/discovery/package.json`.

- [ ] **Step 2: Write failing tests**

Append to `tests/unit/discovery.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL, cannot resolve `@jobfinder/discovery` exports.

- [ ] **Step 4: Write `packages/discovery/src/seed-list.ts`**

```ts
import { isIP } from "node:net";

export interface SeedRow {
  name: string;
  domain: string;
}

export interface SeedListResult {
  rows: SeedRow[];
  rejected: { line: number; reason: string }[];
}

export const seedListLimit = 500;
const fieldLimit = 200;

/** Suffixes where the registrable domain has three labels. Small, built in. */
const twoLevelSuffixes = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.kr",
  "co.in",
  "co.za",
  "com.br",
  "com.mx",
  "com.ar",
  "com.sg",
  "com.hk",
  "com.tr",
  "co.il",
]);

/** Lowercase registrable domain, or null when the host is not a public name. */
export function registrableDomain(host: string): string | null {
  const cleaned = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!cleaned || isIP(cleaned) || !cleaned.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(cleaned) || cleaned.includes("..")) return null;
  const labels = cleaned.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = twoLevelSuffixes.has(lastTwo) ? 3 : 2;
  if (labels.length < keep) return null;
  return labels.slice(-keep).join(".");
}

function domainFromToken(token: string): string | null {
  const value = token.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  try {
    const url = new URL(
      /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`,
    );
    return registrableDomain(url.hostname);
  } catch {
    return null;
  }
}

/** Minimal RFC 4180 line split: quoted fields may contain commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(current);
      current = "";
    } else current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

const headerPattern = /^(company|name|website|domain|url)$/i;

/**
 * Accepts pasted lines (`Acme, acme.com`, `acme.com`, a URL) or CSV with a
 * `name,domain`-style header. Nothing is guessed from a bare company name.
 */
export function parseSeedList(text: string): SeedListResult {
  const rows: SeedRow[] = [];
  const rejected: SeedListResult["rejected"] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  let nameIndex = 0;
  let domainIndex = -1;
  lines.forEach((raw, offset) => {
    const line = offset + 1;
    if (!raw.trim()) return;
    const fields = splitCsvLine(raw);
    if (
      offset === 0 &&
      fields.length >= 2 &&
      fields.every((f) => headerPattern.test(f))
    ) {
      nameIndex = fields.findIndex((f) => /^(company|name)$/i.test(f));
      domainIndex = fields.findIndex((f) => /^(website|domain|url)$/i.test(f));
      return;
    }
    if (rows.length >= seedListLimit) {
      rejected.push({ line, reason: `Import limit is ${seedListLimit} rows` });
      return;
    }
    let name = "";
    let domain: string | null = null;
    if (domainIndex >= 0) {
      domain = domainFromToken(fields[domainIndex] ?? "");
      name = fields[nameIndex] ?? "";
    } else {
      for (const field of fields) {
        const candidate = domainFromToken(field);
        if (candidate && !domain) domain = candidate;
        else if (!name && field && !candidate) name = field;
      }
    }
    if (!domain) {
      rejected.push({ line, reason: "No domain found" });
      return;
    }
    if (seen.has(domain)) {
      rejected.push({ line, reason: "Duplicate domain" });
      return;
    }
    seen.add(domain);
    rows.push({
      name: (name || domain).slice(0, fieldLimit),
      domain: domain.slice(0, fieldLimit),
    });
  });
  return { rows, rejected };
}
```

- [ ] **Step 5: Write `packages/discovery/src/robots.ts`**

```ts
export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsRules {
  /** Lowercased agent token to its rules. `*` is the wildcard group. */
  groups: Map<string, RobotsRule[]>;
}

export class RobotsBlockedError extends Error {
  constructor(
    public readonly url: string,
    public readonly matchedRule: string,
  ) {
    super(`robots.txt disallows ${url} (${matchedRule})`);
    this.name = "RobotsBlockedError";
  }
}

/** Parses User-agent / Allow / Disallow groups. Unknown directives are ignored. */
export function parseRobots(text: string): RobotsRules {
  const groups = new Map<string, RobotsRule[]>();
  let agents: string[] = [];
  let sawRule = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === "user-agent") {
      if (sawRule) {
        agents = [];
        sawRule = false;
      }
      agents.push(value.toLowerCase());
      for (const agent of agents) if (!groups.has(agent)) groups.set(agent, []);
    } else if (directive === "allow" || directive === "disallow") {
      sawRule = true;
      if (!value && directive === "disallow") continue; // empty Disallow allows all
      for (const agent of agents)
        groups.get(agent)?.push({ allow: directive === "allow", path: value });
    }
  }
  return { groups };
}

function ruleMatches(rulePath: string, path: string): boolean {
  const pattern = rulePath
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const anchored = pattern.endsWith("\\$")
    ? `^${pattern.slice(0, -2)}$`
    : `^${pattern}`;
  return new RegExp(anchored).test(path);
}

/**
 * Longest-match evaluation like Google's robots parser. A group for our agent
 * replaces the wildcard group entirely; no group means everything is allowed.
 */
export function robotsAllows(
  rules: RobotsRules,
  path: string,
  agent: string,
): { allowed: boolean; matchedRule?: string } {
  const group =
    rules.groups.get(agent.toLowerCase()) ?? rules.groups.get("*") ?? [];
  let best: RobotsRule | undefined;
  for (const rule of group) {
    if (!ruleMatches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    )
      best = rule;
  }
  if (!best || best.allow) return { allowed: true };
  return { allowed: false, matchedRule: `Disallow: ${best.path}` };
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add packages/discovery Dockerfile package-lock.json tests/unit/discovery.test.ts
git commit -m "Add discovery package with seed list and robots parsers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Discovery transport (redirects, robots gate) and POST support in the connector transport

**Files:**

- Modify: `packages/job-sources/src/transport.ts` (`TransportOptions` gains `method`/`body`; both branches honour them)
- Create: `packages/discovery/src/transport.ts`
- Modify: `packages/discovery/src/index.ts` (add `export * from "./transport";`)
- Test: `tests/unit/discovery.test.ts` (append)

**Interfaces:**

- Consumes: `fetchText`, `assertHttpsUrl`, `TransportOptions` from `@jobfinder/job-sources`; `parseRobots`, `robotsAllows`, `RobotsBlockedError` from Task 3; `PolicyCheck` from Task 1.
- Produces:
  - `TransportOptions.method?: "GET" | "POST"`, `TransportOptions.body?: string`.
  - `export const discoveryUserAgent = "JobFinderBot/1.0"`.
  - `class RobotsCache { constructor(options: TransportOptions); check(url: URL): Promise<PolicyCheck>; assertAllowed(url: URL): Promise<PolicyCheck> }` — `assertAllowed` throws `RobotsBlockedError`.
  - `interface DiscoveryFetchResult { finalUrl: URL; chain: string[]; status: number; text: string; contentType: string }`.
  - `discoveryFetch(url: URL, options: TransportOptions & { robots: RobotsCache }): Promise<DiscoveryFetchResult>` — follows ≤3 redirects, each HTTPS + public + robots-checked. Throws `Error("Too many redirects")` on the 4th.

- [ ] **Step 1: Failing tests**

Append to `tests/unit/discovery.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL, `discoveryFetch` not exported.

- [ ] **Step 3: Add method and body to the connector transport**

In `packages/job-sources/src/transport.ts`:

```ts
export interface TransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** GET unless a captured pattern says POST. */
  method?: "GET" | "POST";
  /** Raw request body; only sent with POST. */
  body?: string;
  /** Dependency injection for deterministic tests; never populated from source config. */
  fetchImpl?: typeof fetch;
  resolveHost?: (
    hostname: string,
  ) => Promise<{ address: string; family: number }[]>;
}
```

In `fetchText`, define `const method = options.method ?? "GET";` and `const body = method === "POST" ? (options.body ?? "") : undefined;`. In the `fetchImpl` branch pass `method` and `body` to the fetch call:

```ts
const response = await options.fetchImpl(url, {
  method,
  body,
  headers: requestHeaders,
  redirect: "error",
  signal,
});
```

In the `https.request` branch add `method` to the request options and write the body before `req.end()`:

```ts
const req = request(
  url,
  {
    method,
    headers: {
      ...requestHeaders,
      ...(body !== undefined
        ? { "Content-Length": String(Buffer.byteLength(body)) }
        : {}),
    },
    signal,
    agent: false,
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    },
  },
  (res) => {
    /* unchanged */
  },
);
req.on("error", reject);
if (body !== undefined) req.write(body);
req.end();
```

- [ ] **Step 4: Write `packages/discovery/src/transport.ts`**

```ts
import {
  assertHttpsUrl,
  fetchText,
  type TransportOptions,
} from "@jobfinder/job-sources";
import type { PolicyCheck } from "@jobfinder/shared";
import {
  parseRobots,
  robotsAllows,
  RobotsBlockedError,
  type RobotsRules,
} from "./robots";

export const discoveryUserAgent = "JobFinderBot/1.0";
const maxRedirects = 3;

/**
 * One robots.txt fetch per host per resolver run. A missing, failing or
 * unreadable file allows everything, which matches how crawlers treat 404s;
 * a reachable file is honoured exactly.
 */
export class RobotsCache {
  private readonly rules = new Map<string, Promise<RobotsRules>>();
  constructor(private readonly options: TransportOptions) {}

  private load(host: string): Promise<RobotsRules> {
    let pending = this.rules.get(host);
    if (!pending) {
      pending = (async () => {
        try {
          const { response, text } = await fetchText(
            new URL(`https://${host}/robots.txt`),
            { Accept: "text/plain" },
            { ...this.options, maxBytes: 512 * 1024 },
          );
          return response.ok ? parseRobots(text) : parseRobots("");
        } catch {
          return parseRobots("");
        }
      })();
      this.rules.set(host, pending);
    }
    return pending;
  }

  async check(url: URL): Promise<PolicyCheck> {
    const rules = await this.load(url.hostname);
    const verdict = robotsAllows(
      rules,
      `${url.pathname}${url.search}`,
      "JobFinderBot",
    );
    return {
      robotsAllowed: verdict.allowed,
      robotsUrl: `https://${url.hostname}/robots.txt`,
      checkedAt: new Date().toISOString(),
      userAgent: discoveryUserAgent,
      ...(verdict.matchedRule ? { matchedRule: verdict.matchedRule } : {}),
    };
  }

  async assertAllowed(url: URL): Promise<PolicyCheck> {
    const check = await this.check(url);
    if (!check.robotsAllowed)
      throw new RobotsBlockedError(url.href, check.matchedRule ?? "Disallow");
    return check;
  }
}

export interface DiscoveryFetchResult {
  finalUrl: URL;
  chain: string[];
  status: number;
  text: string;
  contentType: string;
}

/**
 * The connector transport never follows redirects. Discovery needs to, because
 * homepages bounce to `www.` and careers links bounce to ATS hosts. Every hop
 * is re-validated: HTTPS, public address, robots.
 */
export async function discoveryFetch(
  url: URL,
  options: TransportOptions & { robots: RobotsCache },
): Promise<DiscoveryFetchResult> {
  const { robots, ...transport } = options;
  let current = new URL(url.href);
  const chain: string[] = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertHttpsUrl(current);
    await robots.assertAllowed(current);
    chain.push(current.href);
    const { response, text } = await fetchText(
      current,
      {
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
      },
      transport,
    );
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === maxRedirects) throw new Error("Too many redirects");
      current = new URL(location, current);
      continue;
    }
    return {
      finalUrl: current,
      chain,
      status: response.status,
      text,
      contentType: response.headers.get("content-type") ?? "",
    };
  }
  throw new Error("Too many redirects");
}
```

- [ ] **Step 5: Export and run tests**

Add `export * from "./transport";` to `packages/discovery/src/index.ts`.

Run: `npx vitest run tests/unit/discovery.test.ts tests/unit/job-sources.test.ts`
Expected: PASS (existing connector tests still green; the fake fetches ignore the new `method`).

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add packages/job-sources/src/transport.ts packages/discovery tests/unit/discovery.test.ts
git commit -m "Add redirect-following discovery transport with robots gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Careers URL finder

**Files:**

- Create: `packages/discovery/src/careers.ts`
- Modify: `packages/discovery/src/index.ts` (add export)
- Test: `tests/unit/discovery.test.ts` (append)

**Interfaces:**

- Consumes: `discoveryFetch`, `RobotsCache`, `DiscoveryFetchResult` (Task 4); `registrableDomain` (Task 3).
- Produces:
  - `extractAnchors(html: string, base: URL): { href: URL; text: string }[]`
  - `scoreCareersLinks(html: string, base: URL, domain: string): { url: URL; score: number }[]` sorted descending, only links on the registrable domain or a known ATS host.
  - `careersProbePaths = ["/careers", "/jobs", "/careers/jobs", "/company/careers", "/about/careers"]`.
  - `atsHostPattern: RegExp` matching the ATS hosts listed in the spec.
  - `findCareersPage(domain: string, options: TransportOptions & { robots: RobotsCache }): Promise<DiscoveryFetchResult | null>`.

- [ ] **Step 1: Failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL, `findCareersPage` not exported.

- [ ] **Step 3: Write `packages/discovery/src/careers.ts`**

```ts
import type { TransportOptions } from "@jobfinder/job-sources";
import { registrableDomain } from "./seed-list";
import {
  discoveryFetch,
  type DiscoveryFetchResult,
  type RobotsCache,
} from "./transport";
import { RobotsBlockedError } from "./robots";

export const careersProbePaths = [
  "/careers",
  "/jobs",
  "/careers/jobs",
  "/company/careers",
  "/about/careers",
] as const;

export const atsHostPattern =
  /(^|\.)(boards\.greenhouse\.io|job-boards\.greenhouse\.io|boards-api\.greenhouse\.io|jobs\.lever\.co|api\.lever\.co|jobs\.ashbyhq\.com|api\.ashbyhq\.com|myworkdayjobs\.com|jobs\.smartrecruiters\.com|icims\.com|taleo\.net)$/i;

const strongTerms = [
  "careers",
  "career",
  "jobs",
  "open positions",
  "open roles",
  "opportunities",
  "join us",
  "join our team",
  "work with us",
  "we're hiring",
  "we are hiring",
  "employment",
];

export function extractAnchors(html: string, base: URL) {
  const anchors: { href: URL; text: string }[] = [];
  const pattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      const href = new URL(match[1], base);
      if (href.protocol !== "https:" && href.protocol !== "http:") continue;
      href.protocol = "https:";
      href.hash = "";
      const text = match[2]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      anchors.push({ href, text });
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return anchors;
}

/**
 * Links whose text or path reads like a careers destination. Blog posts about
 * jobs score lower than a `/careers` path; third-party hosts are excluded
 * unless they are a recognised ATS.
 */
export function scoreCareersLinks(html: string, base: URL, domain: string) {
  const scored = new Map<string, { url: URL; score: number }>();
  for (const { href, text } of extractAnchors(html, base)) {
    const sameDomain = registrableDomain(href.hostname) === domain;
    if (!sameDomain && !atsHostPattern.test(href.hostname)) continue;
    const path = href.pathname.toLowerCase();
    const lowerText = text.toLowerCase();
    let score = 0;
    for (const term of strongTerms) {
      if (lowerText === term) score += 6;
      else if (lowerText.includes(term)) score += 3;
      if (
        path.split("/").some((segment) => segment === term.replace(/ /g, "-"))
      )
        score += 5;
      else if (path.includes(term.replace(/ /g, "-"))) score += 1;
    }
    if (/\/blog\//.test(path) || /\/news\//.test(path)) score -= 4;
    if (!sameDomain) score += 2; // an ATS link is a strong signal
    if (score <= 0) continue;
    const key = href.href;
    const existing = scored.get(key);
    if (!existing || existing.score < score)
      scored.set(key, { url: href, score });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score);
}

async function tryFetch(
  url: URL,
  options: TransportOptions & { robots: RobotsCache },
): Promise<DiscoveryFetchResult | null> {
  try {
    const result = await discoveryFetch(url, options);
    return result.status === 200 && result.text.trim() ? result : null;
  } catch (error) {
    if (error instanceof RobotsBlockedError) throw error;
    return null;
  }
}

/**
 * Homepage first (`https://{domain}/`, then `https://www.{domain}/`), best
 * scoring link next, then the fixed probe list. Robots refusals propagate so
 * the caller records `Blocked` instead of silently trying the next path.
 */
export async function findCareersPage(
  domain: string,
  options: TransportOptions & { robots: RobotsCache },
): Promise<DiscoveryFetchResult | null> {
  const home =
    (await tryFetch(new URL(`https://${domain}/`), options)) ??
    (await tryFetch(new URL(`https://www.${domain}/`), options));
  const base = home?.finalUrl ?? new URL(`https://${domain}/`);
  if (home) {
    const [best] = scoreCareersLinks(home.text, home.finalUrl, domain);
    if (best) {
      const page = await tryFetch(best.url, options);
      if (page) return page;
    }
  }
  for (const path of careersProbePaths) {
    const page = await tryFetch(new URL(path, base), options);
    if (page) return page;
  }
  return null;
}
```

- [ ] **Step 4: Export, run tests**

Add `export * from "./careers";` to the index.

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add packages/discovery tests/unit/discovery.test.ts
git commit -m "Add careers page finder with link scoring and path probes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: ATS detector

**Files:**

- Create: `packages/discovery/src/ats.ts`
- Create fixtures: `tests/fixtures/discovery/ats/greenhouse-embed.html`, `lever-link.html`, `ashby-iframe.html`, `workday-redirect.html`
- Modify: `packages/discovery/src/index.ts`
- Test: `tests/unit/discovery.test.ts` (append)

**Interfaces:**

- Consumes: `DetectableAts` (Task 1), `extractAnchors` (Task 5).
- Produces: `detectAts(input: { finalUrl: URL; chain: string[]; html: string }): { ats: DetectableAts; key: string } | null`.

- [ ] **Step 1: Fixtures**

`tests/fixtures/discovery/ats/greenhouse-embed.html`:

```html
<html>
  <body>
    <h1>Careers</h1>
    <div id="grnhse_app"></div>
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmecorp"></script>
  </body>
</html>
```

`tests/fixtures/discovery/ats/lever-link.html`:

```html
<html>
  <body>
    <p>See our roles</p>
    <a href="https://jobs.lever.co/acme-labs?department=Eng">All openings</a>
  </body>
</html>
```

`tests/fixtures/discovery/ats/ashby-iframe.html`:

```html
<html>
  <body>
    <iframe src="https://jobs.ashbyhq.com/acme/embed" title="Jobs"></iframe>
  </body>
</html>
```

`tests/fixtures/discovery/ats/workday-redirect.html`:

```html
<html>
  <body>
    <p>Loading…</p>
  </body>
</html>
```

- [ ] **Step 2: Failing tests**

```ts
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
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL, `detectAts` not exported.

- [ ] **Step 4: Write `packages/discovery/src/ats.ts`**

```ts
import type { DetectableAts } from "@jobfinder/shared";
import { extractAnchors } from "./careers";

export interface AtsDetection {
  ats: DetectableAts;
  key: string;
}

const firstSegment = (url: URL) =>
  url.pathname.split("/").filter(Boolean)[0] ?? "";

/** Host matchers in priority order; the first URL that matches wins. */
const matchers: ((url: URL) => AtsDetection | null)[] = [
  (url) => {
    if (!/^(boards|job-boards|boards-api)\.greenhouse\.io$/i.test(url.hostname))
      return null;
    const embedded = url.searchParams.get("for");
    const key =
      embedded ??
      (firstSegment(url) === "v1"
        ? (url.pathname.split("/").filter(Boolean)[2] ?? "")
        : firstSegment(url) === "embed"
          ? ""
          : firstSegment(url));
    return key ? { ats: "Greenhouse", key } : null;
  },
  (url) => {
    if (!/^(jobs|api)\.lever\.co$/i.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const key =
      segments[0] === "v0" ? (segments[2] ?? "") : (segments[0] ?? "");
    return key ? { ats: "Lever", key } : null;
  },
  (url) => {
    if (!/^(jobs|api)\.ashbyhq\.com$/i.test(url.hostname)) return null;
    const key = firstSegment(url);
    return key && key !== "posting-api" ? { ats: "Ashby", key } : null;
  },
  (url) => {
    const match = url.hostname.match(
      /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i,
    );
    return match ? { ats: "Workday", key: match[1] } : null;
  },
  (url) => {
    if (!/^jobs\.smartrecruiters\.com$/i.test(url.hostname)) return null;
    const key = firstSegment(url);
    return key ? { ats: "SmartRecruiters", key } : null;
  },
  (url) => {
    const match = url.hostname.match(/^([a-z0-9-]+)\.icims\.com$/i);
    return match ? { ats: "iCIMS", key: match[1] } : null;
  },
  (url) => {
    const match = url.hostname.match(/^([a-z0-9-]+)\.taleo\.net$/i);
    return match ? { ats: "Taleo", key: match[1] } : null;
  },
];

function detectUrl(url: URL): AtsDetection | null {
  for (const matcher of matchers) {
    const hit = matcher(url);
    if (hit) return hit;
  }
  return null;
}

function candidateUrls(input: {
  finalUrl: URL;
  chain: string[];
  html: string;
}) {
  const urls: URL[] = [input.finalUrl];
  for (const href of input.chain) {
    try {
      urls.push(new URL(href));
    } catch {
      // ignore
    }
  }
  const attr =
    /<(?:script|iframe|link|embed)\b[^>]*?(?:src|href)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(input.html))) {
    try {
      urls.push(new URL(match[1], input.finalUrl));
    } catch {
      // ignore
    }
  }
  for (const anchor of extractAnchors(input.html, input.finalUrl))
    urls.push(anchor.href);
  return urls;
}

/**
 * Pure: inspects the final URL, the redirect chain, then scripts, iframes,
 * links and anchors for a known ATS host and extracts the board key.
 */
export function detectAts(input: {
  finalUrl: URL;
  chain: string[];
  html: string;
}): AtsDetection | null {
  for (const url of candidateUrls(input)) {
    const hit = detectUrl(url);
    if (hit) return hit;
  }
  return null;
}
```

- [ ] **Step 5: Export, run tests**

Add `export * from "./ats";` to the index.

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add packages/discovery tests/unit/discovery.test.ts tests/fixtures/discovery
git commit -m "Add pure ATS detector with vendor fixtures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Posting-link collector, shared JSON-LD normalizer and the `Careers` connector

**Files:**

- Create: `packages/job-sources/src/posting-links.ts`
- Modify: `packages/job-sources/src/connectors/json-ld.ts` (export `extractJsonLdJobs`, `jsonLdJobSchema`, `JsonLdJob`, `normalizeJsonLdJob`; extend schema)
- Create: `packages/job-sources/src/connectors/careers.ts`
- Modify: `packages/job-sources/src/connectors/index.ts`, `packages/job-sources/src/index.ts` (`SourceProvider` union, `providerName`, `createConnector`, re-exports)
- Test: `tests/unit/discovery-connectors.test.ts`

**Interfaces:**

- Produces:
  - `collectPostingLinks(html: string, base: URL, cap = 200): URL[]` — same registrable host as `base`, path looks like a posting, deduped, in document order.
  - `extractJsonLdJobs(html: string): JsonLdJob[]`; `normalizeJsonLdJob(raw: JsonLdJob, context: NormalizeContext, provider: SourceProvider): NormalizedJob`.
  - `createCareersConnector(options: ConnectorOptions): SourceConnector<JsonLdJob>` with `name: "Careers"`. `search` requires `query.sourceUrl`.
  - `SourceProvider` now includes `"Careers" | "CapturedApi" | "Browser"`; `providerName("careers")` etc. resolve.

- [ ] **Step 1: Failing tests**

```ts
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
    expect(links.map((u) => u.pathname)).toEqual([
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/discovery-connectors.test.ts`
Expected: FAIL, `collectPostingLinks` not exported.

- [ ] **Step 3: Write `packages/job-sources/src/posting-links.ts`**

```ts
const postingSegment =
  /^(jobs?|positions?|openings?|careers?|roles?|vacanc(y|ies)|opportunit(y|ies)|postings?|requisitions?)$/i;

const hostOf = (url: URL) => url.hostname.replace(/^www\./, "");

/**
 * Anchors that look like individual postings: same host as the listing page,
 * a posting-ish segment followed by at least one more segment (a slug or id).
 * `/jobs` alone is a listing, not a posting.
 */
export function collectPostingLinks(html: string, base: URL, cap = 200): URL[] {
  const seen = new Set<string>();
  const links: URL[] = [];
  const pattern = /<a\b[^>]*href=["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && links.length < cap) {
    let url: URL;
    try {
      url = new URL(match[1], base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || hostOf(url) !== hostOf(base)) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    const index = segments.findIndex((segment) => postingSegment.test(segment));
    if (index < 0 || index === segments.length - 1) continue;
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    const key = url.href;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(url);
  }
  return links;
}
```

- [ ] **Step 4: Refactor `json-ld.ts`**

Replace the top of the file so the schema and extractor are exported and richer:

```ts
export const jsonLdJobSchema = z.object({
  "@type": z.literal("JobPosting"),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  identifier: z
    .union([
      z.string(),
      z.number(),
      z.object({ value: z.union([z.string(), z.number()]).optional() }),
    ])
    .nullable()
    .optional(),
  datePosted: z.string().optional().nullable(),
  validThrough: z.string().optional().nullable(),
  employmentType: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default(""),
  jobLocationType: z.string().optional().nullable(),
  hiringOrganization: z.object({ name: z.string().optional() }).optional(),
  jobLocation: z
    .union([
      z.object({ address: addressSchema.optional() }),
      z.array(z.object({ address: addressSchema.optional() })),
    ])
    .nullable()
    .optional(),
  applicantLocationRequirements: z
    .union([
      z.object({ name: z.string().optional() }),
      z.array(z.object({ name: z.string().optional() })),
    ])
    .nullable()
    .optional(),
  baseSalary: z
    .object({
      currency: z.string().optional(),
      value: z
        .object({
          value: z.union([z.number(), z.string()]).optional(),
          minValue: z.union([z.number(), z.string()]).optional(),
          maxValue: z.union([z.number(), z.string()]).optional(),
          unitText: z.string().optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});
export type JsonLdJob = z.infer<typeof jsonLdJobSchema>;

const addressSchema = z.object({
  addressLocality: z.string().optional(),
  addressRegion: z.string().optional(),
  addressCountry: z
    .union([z.string(), z.object({ name: z.string().optional() })])
    .optional(),
});
```

(Declare `addressSchema` above `jsonLdJobSchema`.) Rename `extractJobs` to `export function extractJsonLdJobs` and use `jsonLdJobSchema.safeParse`. Add the shared identity and normalizer:

```ts
export function jsonLdExternalId(job: JsonLdJob): string {
  const id = job.identifier;
  if (typeof id === "string" || typeof id === "number") return String(id);
  if (id && typeof id === "object" && id.value !== undefined)
    return String(id.value);
  return job.url;
}

const toInt = (value: number | string | undefined) => {
  if (value === undefined) return null;
  const parsed = Math.round(Number(String(value).replace(/[^0-9.]/g, "")));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const currencyOf = (
  value: string | undefined,
): "CAD" | "USD" | "EUR" | "GBP" | "Unknown" => {
  const upper = (value ?? "").toUpperCase();
  return upper === "CAD" ||
    upper === "USD" ||
    upper === "EUR" ||
    upper === "GBP"
    ? upper
    : "Unknown";
};

const periodOf = (unit: string | undefined) => {
  const upper = (unit ?? "").toUpperCase();
  if (upper === "YEAR") return "year" as const;
  if (upper === "MONTH") return "month" as const;
  if (upper === "WEEK") return "week" as const;
  if (upper === "DAY") return "day" as const;
  if (upper === "HOUR") return "hour" as const;
  return "unknown" as const;
};

/** Shared by the allowlisted JSON-LD connector and the per-company Careers connector. */
export function normalizeJsonLdJob(
  raw: JsonLdJob,
  context: NormalizeContext,
  provider: SourceProvider,
): NormalizedJob {
  const description = htmlToText(raw.description);
  const locations = Array.isArray(raw.jobLocation)
    ? raw.jobLocation
    : raw.jobLocation
      ? [raw.jobLocation]
      : [];
  const address = locations[0]?.address;
  const country =
    typeof address?.addressCountry === "string"
      ? address.addressCountry
      : (address?.addressCountry?.name ?? "");
  const requirements = Array.isArray(raw.applicantLocationRequirements)
    ? raw.applicantLocationRequirements
    : raw.applicantLocationRequirements
      ? [raw.applicantLocationRequirements]
      : [];
  const applicantCountries = requirements
    .map((r) => r.name)
    .filter((n): n is string => Boolean(n));
  const location = [
    [address?.addressLocality, address?.addressRegion]
      .filter(Boolean)
      .join(", "),
    applicantCountries.length
      ? `Applicants: ${applicantCountries.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const employment = Array.isArray(raw.employmentType)
    ? raw.employmentType.join(" ")
    : raw.employmentType;
  const remote =
    /TELECOMMUTE/i.test(raw.jobLocationType ?? "") ||
    /remote/i.test(`${raw.title} ${description}`);
  const salary = raw.baseSalary?.value;
  const single = toInt(salary?.value);
  const input = jobInputSchema.parse({
    title: raw.title,
    company:
      raw.hiringOrganization?.name ||
      context.query.company ||
      context.query.board,
    description,
    location,
    country,
    industry: "",
    employmentType: /contract/i.test(employment)
      ? "Contract"
      : /part|temp/i.test(employment)
        ? "Temporary"
        : /full/i.test(employment)
          ? "Full-time"
          : "Unknown",
    seniority: "Unknown",
    workType: remote ? "Remote" : "Unknown",
    salaryMin: toInt(salary?.minValue) ?? single,
    salaryMax: toInt(salary?.maxValue) ?? single,
    salaryPeriod: periodOf(salary?.unitText),
    currency: currencyOf(raw.baseSalary?.currency),
    jobUrl: raw.url,
    postedAt: isoDate(raw.datePosted),
  });
  return {
    ...input,
    externalId: jsonLdExternalId(raw),
    provider,
    sourceUrl: raw.url,
    descriptionHash: descriptionDigest(description),
  };
}
```

Make the existing JSON-LD connector's `normalize` call `normalizeJsonLdJob(raw, context, "JSON-LD")`, its `externalId` computation use `jsonLdExternalId`, and its `fetchJob` lookup use `jsonLdExternalId(candidate) === reference.externalId`. Import `SourceProvider`, `NormalizedJob`, `NormalizeContext` from `../index`.

- [ ] **Step 5: Write `packages/job-sources/src/connectors/careers.ts`**

```ts
import {
  assertHttpsUrl,
  fetchText,
  retryAfterMs,
  SourceHttpError,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";
import { collectPostingLinks } from "../posting-links";
import {
  extractJsonLdJobs,
  jsonLdExternalId,
  normalizeJsonLdJob,
  type JsonLdJob,
} from "./json-ld";

const maxPostingPages = 100;
const maxLinks = 200;

/**
 * A company careers page the resolver approved. Postings come from JSON-LD on
 * the listing page, or from JSON-LD on individual posting pages the listing
 * links to. No env allowlist: the per-company candidate row is the gate.
 */
export function createCareersConnector(
  options: ConnectorOptions = {},
): SourceConnector<JsonLdJob> {
  const cache = new Map<string, JsonLdJob>();
  const get = async (url: URL, signal?: AbortSignal) => {
    assertHttpsUrl(url);
    const { response, text } = await fetchText(url, {}, { ...options, signal });
    if (!response.ok)
      throw new SourceHttpError(
        response.status,
        retryAfterMs(response.headers.get("retry-after")),
      );
    return text;
  };
  return {
    name: "Careers",
    async search(query, _cursor, signal) {
      if (!query.sourceUrl) throw new Error("A careers page URL is required");
      const listingUrl = new URL(query.sourceUrl);
      const html = await get(listingUrl, signal);
      const inline = extractJsonLdJobs(html);
      const jobs = inline.map((job) => {
        const externalId = jsonLdExternalId(job);
        cache.set(externalId, job);
        return {
          externalId,
          url: job.url,
          sourceUrl: query.sourceUrl,
          company: query.company,
        };
      });
      const links = collectPostingLinks(html, listingUrl, maxLinks);
      const known = new Set(inline.map((job) => job.url));
      for (const link of links) {
        if (known.has(link.href)) continue;
        jobs.push({
          externalId: link.href,
          url: link.href,
          sourceUrl: query.sourceUrl,
          company: query.company,
        });
      }
      return {
        jobs: jobs.slice(0, maxLinks),
        complete: links.length < maxLinks,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      const cached = cache.get(reference.externalId);
      if (cached) return cached;
      if (cache.size >= maxPostingPages + maxLinks)
        throw new Error("Posting page cap reached for this scan");
      const html = await get(new URL(reference.url), signal);
      const job =
        extractJsonLdJobs(html).find(
          (candidate) =>
            candidate.url === reference.url ||
            jsonLdExternalId(candidate) === reference.externalId,
        ) ?? extractJsonLdJobs(html)[0];
      if (!job) throw new Error("Posting page has no JobPosting JSON-LD");
      const normalizedId = reference.externalId;
      cache.set(normalizedId, { ...job, url: job.url || reference.url });
      return { ...job, url: job.url || reference.url };
    },
    async normalize(raw, context) {
      return normalizeJsonLdJob(raw, context, "Careers");
    },
  };
}
```

- [ ] **Step 6: Wire into `index.ts`**

In `packages/job-sources/src/index.ts`:

```ts
export type SourceProvider =
  | "Greenhouse"
  | "Lever"
  | "Ashby"
  | "RemoteOK"
  | "Jobicy"
  | "JSON-LD"
  | "Careers"
  | "CapturedApi"
  | "Browser";
```

In `providerName` add before the throw:

```ts
if (normalized === "careers") return "Careers";
if (normalized === "capturedapi" || normalized === "captured-api")
  return "CapturedApi";
if (normalized === "browser") return "Browser";
```

In `createConnector` add `case "Careers": return createCareersConnector(options);` (the `CapturedApi` and `Browser` cases come in Tasks 8 and 9; until then add them too but temporarily `throw new Error("Not implemented")` so the switch stays exhaustive, and remove those throws in the later tasks). Export `createCareersConnector` and `export * from "./posting-links";` and `export { extractJsonLdJobs, jsonLdExternalId, normalizeJsonLdJob, jsonLdJobSchema, type JsonLdJob } from "./connectors/json-ld";`. Add `export { createCareersConnector } from "./careers";` to `connectors/index.ts`.

- [ ] **Step 7: Run all unit tests**

Run: `npx vitest run`
Expected: PASS. The existing JSON-LD tests in `tests/unit/job-sources.test.ts` still pass through the shared normalizer.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add packages/job-sources tests/unit/discovery-connectors.test.ts
git commit -m "Add Careers connector and shared JSON-LD normalizer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Crawler client and the `Browser` connector

**Files:**

- Create: `packages/job-sources/src/crawler-client.ts`
- Create: `packages/job-sources/src/connectors/browser.ts`
- Modify: `packages/job-sources/src/index.ts` (`ConnectorOptions.crawlerClient`, exports, `createConnector` case), `connectors/index.ts`
- Test: `tests/unit/discovery-connectors.test.ts` (append)

**Interfaces:**

- Consumes: `crawlRequestSchema`, `crawlResponseSchema`, `captureRequestSchema`, `captureResponseSchema`, `crawlerErrorSchema`, `CrawledJob` from `@jobfinder/shared` (Task 1).
- Produces:
  - `interface CrawlerClient { crawl(input: CrawlRequest, signal?: AbortSignal): Promise<CrawlResponse>; capture(input: { url: string }, signal?: AbortSignal): Promise<CaptureResponse> }`
  - `class CrawlerRequestError extends Error { kind: CrawlerError["kind"] }`
  - `createHttpCrawlerClient(config: { url: string; secret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): CrawlerClient`
  - `crawlerClientFromEnv(env = process.env): CrawlerClient | null` — null when `CRAWLER_URL` or `CRAWLER_SECRET` is unset.
  - `ConnectorOptions.crawlerClient?: CrawlerClient | null`.
  - `createBrowserConnector(options): SourceConnector<CrawledJob>` with `name: "Browser"`.

- [ ] **Step 1: Failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/discovery-connectors.test.ts`
Expected: FAIL, `createHttpCrawlerClient` not exported.

- [ ] **Step 3: Write `packages/job-sources/src/crawler-client.ts`**

```ts
import {
  captureResponseSchema,
  crawlResponseSchema,
  crawlerErrorSchema,
  type CaptureResponse,
  type CrawlRequest,
  type CrawlResponse,
  type CrawlerError,
} from "@jobfinder/shared";

/** The worker's view of the isolated browser service. Tests inject a fake. */
export interface CrawlerClient {
  crawl(input: CrawlRequest, signal?: AbortSignal): Promise<CrawlResponse>;
  capture(
    input: { url: string },
    signal?: AbortSignal,
  ): Promise<CaptureResponse>;
}

export class CrawlerRequestError extends Error {
  constructor(
    message: string,
    public readonly kind: CrawlerError["kind"],
  ) {
    super(message);
    this.name = "CrawlerRequestError";
  }
}

export interface HttpCrawlerConfig {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createHttpCrawlerClient(
  config: HttpCrawlerConfig,
): CrawlerClient {
  const base = config.url.replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeout = config.timeoutMs ?? 120_000;
  async function call<T>(
    path: string,
    body: unknown,
    parse: (data: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secret}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new CrawlerRequestError(
        "Crawler returned invalid JSON",
        "internal",
      );
    }
    if (!response.ok) {
      const failure = crawlerErrorSchema.safeParse(data);
      throw new CrawlerRequestError(
        failure.success
          ? failure.data.error
          : `Crawler returned HTTP ${response.status}`,
        failure.success ? failure.data.kind : "internal",
      );
    }
    try {
      return parse(data);
    } catch {
      throw new CrawlerRequestError(
        "Crawler returned an invalid response",
        "internal",
      );
    }
  }
  return {
    crawl: (input, signal) =>
      call("/crawl", input, (d) => crawlResponseSchema.parse(d), signal),
    capture: (input, signal) =>
      call("/capture", input, (d) => captureResponseSchema.parse(d), signal),
  };
}

/** Null means the browser rung is unavailable; callers must say so, not stub it. */
export function crawlerClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): CrawlerClient | null {
  const url = env.CRAWLER_URL?.trim();
  const secret = env.CRAWLER_SECRET?.trim();
  if (!url || !secret) return null;
  return createHttpCrawlerClient({ url, secret });
}
```

- [ ] **Step 4: Write `packages/job-sources/src/connectors/browser.ts`**

```ts
import { jobInputSchema, type CrawledJob } from "@jobfinder/shared";
import { canonicalUrl } from "@jobfinder/shared/hash";
import {
  descriptionDigest,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const maxPages = 20;
const maxJobs = 500;

export const crawledExternalId = (job: CrawledJob) =>
  job.id?.trim() || canonicalUrl(job.url);

/**
 * Last rung of the ladder. One crawler session returns every posting it could
 * read; an incomplete walk (page or job cap) is reported so removals are never
 * marked from a partial view.
 */
export function createBrowserConnector(
  options: ConnectorOptions = {},
): SourceConnector<CrawledJob> {
  const cache = new Map<string, CrawledJob>();
  return {
    name: "Browser",
    async search(query, _cursor, signal) {
      if (!query.sourceUrl) throw new Error("A careers page URL is required");
      const client = options.crawlerClient;
      if (!client)
        throw new Error(
          "Browser crawling is not configured; start the crawler service",
        );
      const result = await client.crawl(
        { url: query.sourceUrl, maxPages, maxJobs },
        signal,
      );
      return {
        jobs: result.jobs.map((job) => {
          const externalId = crawledExternalId(job);
          cache.set(externalId, job);
          return {
            externalId,
            url: job.url,
            sourceUrl: query.sourceUrl,
            company: query.company,
          };
        }),
        complete: result.complete,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const cached = cache.get(reference.externalId);
      if (!cached)
        throw new Error("Crawled posting is no longer available in this scan");
      return cached;
    },
    async normalize(raw, context) {
      const company = context.query.company || context.query.board;
      const description =
        raw.description.trim().length >= 20
          ? raw.description.trim()
          : `No description was captured for this posting. See the original listing at ${raw.url}`;
      const input = jobInputSchema.parse({
        title: raw.title,
        company,
        description,
        location: raw.location,
        country: "",
        industry: "",
        employmentType: "Unknown",
        seniority: "Unknown",
        workType: /remote/i.test(`${raw.title} ${raw.location}`)
          ? "Remote"
          : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.postedAt),
      });
      return {
        ...input,
        externalId: crawledExternalId(raw),
        provider: "Browser" as const,
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
```

- [ ] **Step 5: Wire**

In `index.ts`: `export * from "./crawler-client";`, add `crawlerClient?: CrawlerClient | null;` to `ConnectorOptions` (import the type), replace the `Browser` placeholder case with `return createBrowserConnector(options);`, export `createBrowserConnector`. Add to `connectors/index.ts`.

- [ ] **Step 6: Run tests, commit**

Run: `npx vitest run`
Expected: PASS.

```bash
npm run format && npm run lint && npm run typecheck
git add packages/job-sources tests/unit/discovery-connectors.test.ts
git commit -m "Add crawler client and Browser connector

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Pattern inference, validation and the `CapturedApi` connector

**Files:**

- Create: `packages/discovery/src/patterns.ts`
- Create: `packages/job-sources/src/connectors/captured-api.ts`
- Modify: `packages/job-sources/src/index.ts` (`ConnectorOptions.pattern`, case, export), `connectors/index.ts`, `packages/discovery/src/index.ts`
- Test: `tests/unit/discovery-connectors.test.ts` (append), `tests/unit/discovery.test.ts` (append)

**Interfaces:**

- Consumes: `CapturedRequest`, `CrawlPatternSpec`, `PatternFieldMap`, `jsonPointerGet`, `capturedHeaderAllowlist` (Task 1); `fetchJson`, `TransportOptions` (job-sources).
- Produces:
  - `inferFieldMap(sample: Record<string, unknown>[]): PatternFieldMap | null`
  - `paginationTemplate(captured: CapturedRequest): { urlTemplate: string; body: string | null; paged: boolean }`
  - `buildPatternSpec(captured: CapturedRequest): CrawlPatternSpec | null`
  - `validatePattern(spec: CrawlPatternSpec, options: TransportOptions): Promise<{ ok: true; count: number } | { ok: false; reason: string }>`
  - `ConnectorOptions.pattern?: CrawlPatternSpec`
  - `createCapturedApiConnector(options): SourceConnector<Record<string, unknown>>` with `name: "CapturedApi"`; `renderTemplate(template: string, page: number): string` exported for tests.

- [ ] **Step 1: Failing tests**

Append to `tests/unit/discovery.test.ts`:

```ts
import {
  buildPatternSpec,
  inferFieldMap,
  validatePattern,
} from "@jobfinder/discovery";

describe("Phase 5 saved API patterns", () => {
  const sample = [
    {
      id: 12,
      jobTitle: "VP Engineering",
      applyUrl: "https://acme.example/jobs/12",
      location: { name: "Toronto" },
      content:
        "<p>Lead engineering across three product lines and mentor leads.</p>",
      createdAt: "2026-09-02T00:00:00Z",
    },
  ];
  it("infers a field map from common key names, including nested location", () => {
    expect(inferFieldMap(sample)).toEqual({
      title: "/jobTitle",
      url: "/applyUrl",
      id: "/id",
      location: "/location/name",
      description: "/content",
      postedAt: "/createdAt",
    });
    expect(inferFieldMap([{ foo: 1 }])).toBeNull();
  });

  it("rewrites a numeric page parameter into a template", () => {
    const spec = buildPatternSpec({
      url: "https://acme.example/api/jobs?page=2&size=50",
      method: "GET",
      headers: { accept: "application/json", cookie: "secret=1" },
      body: null,
      jobsPath: "/data",
      sample,
    });
    expect(spec).toMatchObject({
      urlTemplate: "https://acme.example/api/jobs?page={page}&size=50",
      headers: { accept: "application/json" },
      jobsPath: "/data",
    });
    const posted = buildPatternSpec({
      url: "https://acme.example/api/search",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "", page: 3 }),
      jobsPath: "",
      sample,
    });
    expect(posted?.body).toBe(JSON.stringify({ query: "", page: "{page}" }));
  });

  it("validates a pattern by replaying it and mapping one posting", async () => {
    const spec = buildPatternSpec({
      url: "https://acme.example/api/jobs",
      method: "GET",
      headers: {},
      body: null,
      jobsPath: "/data",
      sample,
    })!;
    const ok = await validatePattern(spec, {
      fetchImpl: routeFetch({
        "https://acme.example/api/jobs": () =>
          new Response(JSON.stringify({ data: sample })),
      }),
      resolveHost: publicHost,
    });
    expect(ok).toEqual({ ok: true, count: 1 });
    const empty = await validatePattern(spec, {
      fetchImpl: routeFetch({
        "https://acme.example/api/jobs": () =>
          new Response(JSON.stringify({ data: [] })),
      }),
      resolveHost: publicHost,
    });
    expect(empty).toEqual({ ok: false, reason: "Replay returned no postings" });
  });
});
```

Append to `tests/unit/discovery-connectors.test.ts`:

```ts
import { renderTemplate } from "@jobfinder/job-sources";

describe("Phase 5 CapturedApi connector", () => {
  const pattern = {
    urlTemplate: "https://acme.example/api/jobs?page={page}",
    method: "GET" as const,
    headers: { accept: "application/json" },
    body: null,
    jobsPath: "/data",
    fieldMap: {
      title: "/jobTitle",
      url: "/applyUrl",
      id: "/id",
      location: "/location/name",
      description: "/content",
    },
  };
  const job = (id: number) => ({
    id,
    jobTitle: `Role ${id}`,
    applyUrl: `https://acme.example/jobs/${id}`,
    location: { name: "Remote, Canada" },
    content: "<p>A role with enough description text to pass validation.</p>",
  });

  it("renders page numbers into the template", () => {
    expect(renderTemplate("https://a.example/x?page={page}", 3)).toBe(
      "https://a.example/x?page=3",
    );
  });

  it("walks pages until an empty page and normalizes by field map", async () => {
    const calls: string[] = [];
    const connector = createConnector("CapturedApi", {
      pattern,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        return new Response(
          JSON.stringify({
            data: page === 1 ? [job(1), job(2)] : page === 2 ? [job(3)] : [],
          }),
        );
      }) as typeof fetch,
    });
    const query = {
      board: "acme.example",
      terms: [],
      company: "Acme",
      sourceUrl: "https://acme.example/careers",
    };
    let page = await connector.search(query);
    const ids = [...page.jobs.map((j) => j.externalId)];
    while (!page.complete && page.next) {
      page = await connector.search(query, page.next);
      ids.push(...page.jobs.map((j) => j.externalId));
    }
    expect(ids).toEqual(["1", "2", "3"]);
    expect(calls).toHaveLength(3);
    const normalized = await connector.normalize(
      await connector.fetchJob({
        externalId: "1",
        url: "https://acme.example/jobs/1",
      }),
      { query },
    );
    expect(normalized).toMatchObject({
      provider: "CapturedApi",
      title: "Role 1",
      workType: "Remote",
      location: "Remote, Canada",
    });
  });

  it("throws when the replay returns nothing parseable", async () => {
    const connector = createConnector("CapturedApi", {
      pattern,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ data: [{ nothing: true }] }),
        )) as typeof fetch,
    });
    await expect(
      connector.search({
        board: "a",
        terms: [],
        sourceUrl: "https://acme.example/careers",
      }),
    ).rejects.toThrow(/no postings/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/discovery.test.ts tests/unit/discovery-connectors.test.ts`
Expected: FAIL on missing exports.

- [ ] **Step 3: Write `packages/discovery/src/patterns.ts`**

```ts
import {
  capturedHeaderAllowlist,
  crawlPatternSpecSchema,
  jsonPointerGet,
  type CapturedRequest,
  type CrawlPatternSpec,
  type PatternFieldMap,
} from "@jobfinder/shared";
import {
  fetchJson,
  renderTemplate,
  type TransportOptions,
} from "@jobfinder/job-sources";

const fieldPatterns: {
  field: keyof PatternFieldMap;
  keys: RegExp;
  nested?: RegExp;
}[] = [
  {
    field: "title",
    keys: /^(title|jobTitle|name|position|positionName|role)$/i,
  },
  {
    field: "url",
    keys: /^(url|absolute_url|absoluteUrl|applyUrl|apply_url|link|href|jobUrl|hostedUrl)$/i,
  },
  { field: "id", keys: /^(id|jobId|job_id|requisitionId|reqId|slug)$/i },
  {
    field: "location",
    keys: /^(location|locationName|location_name|city|office)$/i,
    nested: /^(name|city|label|text)$/i,
  },
  {
    field: "description",
    keys: /^(description|content|body|descriptionHtml|jobDescription)$/i,
  },
  {
    field: "postedAt",
    keys: /^(postedAt|posted_at|datePosted|createdAt|created_at|updatedAt|updated_at|publishedAt)$/i,
  },
];

const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Picks pointers from the first sample's keys. Title and URL are mandatory. */
export function inferFieldMap(
  sample: Record<string, unknown>[],
): PatternFieldMap | null {
  const first = sample[0];
  if (!first) return null;
  const map: Partial<PatternFieldMap> = {};
  for (const { field, keys, nested } of fieldPatterns) {
    for (const [key, value] of Object.entries(first)) {
      if (!keys.test(key)) continue;
      if (typeof value === "string" || typeof value === "number") {
        map[field] = `/${escapePointer(key)}`;
        break;
      }
      if (
        nested &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const inner = Object.keys(value).find((k) => nested.test(k));
        if (inner) {
          map[field] = `/${escapePointer(key)}/${escapePointer(inner)}`;
          break;
        }
      }
    }
  }
  if (!map.title || !map.url) return null;
  return map as PatternFieldMap;
}

const pageParam = /^(page|pageNumber|page_number|pageIndex|p)$/i;

/** Only 1-based numeric page parameters are templated. Offsets are left alone. */
export function paginationTemplate(captured: CapturedRequest): {
  urlTemplate: string;
  body: string | null;
  paged: boolean;
} {
  const url = new URL(captured.url);
  let paged = false;
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (pageParam.test(key) && /^\d+$/.test(value)) {
      url.searchParams.set(key, "{page}");
      paged = true;
    }
  }
  let body = captured.body;
  if (body && captured.method === "POST") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (pageParam.test(key) && typeof record[key] === "number") {
            record[key] = "{page}";
            paged = true;
          }
        }
        body = JSON.stringify(record);
      }
    } catch {
      // Non-JSON bodies are replayed verbatim.
    }
  }
  return {
    urlTemplate: url.toString().replace(/%7Bpage%7D/gi, "{page}"),
    body,
    paged,
  };
}

export function buildPatternSpec(
  captured: CapturedRequest,
): CrawlPatternSpec | null {
  const fieldMap = inferFieldMap(captured.sample);
  if (!fieldMap) return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(captured.headers)) {
    const lower = key.toLowerCase();
    if ((capturedHeaderAllowlist as readonly string[]).includes(lower))
      headers[lower] = value;
  }
  const { urlTemplate, body } = paginationTemplate(captured);
  const spec = crawlPatternSpecSchema.safeParse({
    urlTemplate,
    method: captured.method,
    headers,
    body,
    jobsPath: captured.jobsPath,
    fieldMap,
  });
  return spec.success ? spec.data : null;
}

/** Replays page 1 over plain HTTP and requires at least one mapped posting. */
export async function validatePattern(
  spec: CrawlPatternSpec,
  options: TransportOptions,
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  try {
    const url = new URL(renderTemplate(spec.urlTemplate, 1));
    const response = await fetchJson(
      url,
      {
        ...options,
        method: spec.method,
        body: spec.body ? renderTemplate(spec.body, 1) : undefined,
      },
      spec.headers,
    );
    const list = jsonPointerGet(response.data, spec.jobsPath);
    if (!Array.isArray(list))
      return { ok: false, reason: "Replay did not return a list" };
    const valid = list.filter((item) => {
      const title = jsonPointerGet(item, spec.fieldMap.title);
      const link = jsonPointerGet(item, spec.fieldMap.url);
      return (
        typeof title === "string" &&
        title.trim() &&
        typeof link === "string" &&
        /^https?:\/\//.test(link)
      );
    });
    return valid.length
      ? { ok: true, count: valid.length }
      : { ok: false, reason: "Replay returned no postings" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Replay failed",
    };
  }
}
```

- [ ] **Step 4: Write `packages/job-sources/src/connectors/captured-api.ts`**

```ts
import { z } from "zod";
import {
  jobInputSchema,
  jsonPointerGet,
  type CrawlPatternSpec,
} from "@jobfinder/shared";
import { canonicalUrl } from "@jobfinder/shared/hash";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const maxPages = 50;

export const renderTemplate = (template: string, page: number) =>
  template.replaceAll("{page}", String(page));

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";

const mapped = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  id: z.string(),
  location: z.string(),
  description: z.string(),
  postedAt: z.string().nullable(),
});
type MappedJob = z.infer<typeof mapped>;

function mapPosting(
  item: unknown,
  spec: CrawlPatternSpec,
  base: URL,
): MappedJob | null {
  const rawUrl = text(jsonPointerGet(item, spec.fieldMap.url));
  let url = "";
  try {
    url = rawUrl ? new URL(rawUrl, base).href : "";
  } catch {
    url = "";
  }
  const parsed = mapped.safeParse({
    title: text(jsonPointerGet(item, spec.fieldMap.title)),
    url,
    id: spec.fieldMap.id ? text(jsonPointerGet(item, spec.fieldMap.id)) : "",
    location: spec.fieldMap.location
      ? text(jsonPointerGet(item, spec.fieldMap.location))
      : "",
    description: spec.fieldMap.description
      ? text(jsonPointerGet(item, spec.fieldMap.description))
      : "",
    postedAt: spec.fieldMap.postedAt
      ? text(jsonPointerGet(item, spec.fieldMap.postedAt)) || null
      : null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Replays a JSON request the crawler once observed. A page that maps to no
 * posting fails the scan so the pattern's failure counter advances and the
 * candidate is eventually re-resolved.
 */
export function createCapturedApiConnector(
  options: ConnectorOptions = {},
): SourceConnector<MappedJob> {
  const cache = new Map<string, MappedJob>();
  const externalId = (job: MappedJob) => job.id || canonicalUrl(job.url);
  return {
    name: "CapturedApi",
    async search(query, cursor, signal) {
      const spec = options.pattern;
      if (!spec)
        throw new Error("A saved API pattern is required for this source");
      const page = cursor?.cursor ? Number(cursor.cursor) : 1;
      const url = new URL(renderTemplate(spec.urlTemplate, page));
      const response = await fetchJson(
        url,
        {
          ...options,
          signal,
          method: spec.method,
          body: spec.body ? renderTemplate(spec.body, page) : undefined,
        },
        spec.headers,
      );
      const list = jsonPointerGet(response.data, spec.jobsPath);
      if (!Array.isArray(list))
        throw new Error("Saved API replay did not return a list");
      const jobs = list
        .map((item) => mapPosting(item, spec, url))
        .filter((job): job is MappedJob => job !== null);
      if (page === 1 && list.length && !jobs.length)
        throw new Error(
          "Saved API replay returned no postings that match the saved field map",
        );
      for (const job of jobs) cache.set(externalId(job), job);
      const paged =
        spec.urlTemplate.includes("{page}") ||
        Boolean(spec.body?.includes("{page}"));
      const more = paged && list.length > 0 && page < maxPages;
      return {
        jobs: jobs.map((job) => ({
          externalId: externalId(job),
          url: job.url,
          sourceUrl: query.sourceUrl,
          company: query.company,
        })),
        next: more ? { cursor: String(page + 1) } : undefined,
        complete: !more,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const cached = cache.get(reference.externalId);
      if (!cached) throw new Error("Posting was not part of this replay");
      return cached;
    },
    async normalize(raw, context) {
      const description = htmlToText(raw.description);
      const safeDescription =
        description.length >= 20
          ? description
          : `No description was captured for this posting. See the original listing at ${raw.url}`;
      const input = jobInputSchema.parse({
        title: raw.title,
        company: context.query.company || context.query.board,
        description: safeDescription,
        location: raw.location,
        country: "",
        industry: "",
        employmentType: "Unknown",
        seniority: "Unknown",
        workType: /remote/i.test(`${raw.title} ${raw.location}`)
          ? "Remote"
          : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.postedAt),
      });
      return {
        ...input,
        externalId: externalId(raw),
        provider: "CapturedApi" as const,
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(safeDescription),
      };
    },
  };
}
```

Note: `scan.ts` already loops `while (!complete) page = connector.search(query, cursor)`, so the page cursor drives pagination without changes there.

- [ ] **Step 5: Wire**

`index.ts`: add `pattern?: CrawlPatternSpec;` to `ConnectorOptions` (import type from shared), replace the `CapturedApi` placeholder with `return createCapturedApiConnector(options);`, export `createCapturedApiConnector` and `renderTemplate`. `connectors/index.ts`: export both. `packages/discovery/src/index.ts`: `export * from "./patterns";`.

- [ ] **Step 6: Run tests, commit**

Run: `npx vitest run`
Expected: PASS.

```bash
npm run format && npm run lint && npm run typecheck
git add packages/job-sources packages/discovery tests/unit
git commit -m "Add saved API pattern inference and CapturedApi connector

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Scan engine wiring for patterns and the crawler client

**Files:**

- Modify: `packages/automation/src/scan.ts` (`ScanSourceOptions`, connector creation)
- Test: covered by the real-DB test in Task 12; no new unit test.

**Interfaces:**

- Consumes: `crawlPatterns` (Task 2), `crawlerClientFromEnv`, `crawlPatternSpecSchema`.
- Produces: `scanSourceWithDb` loads the source's `crawl_patterns` row for `CapturedApi` and passes it as `connectorOptions.pattern`; passes `connectorOptions.crawlerClient ?? crawlerClientFromEnv()`.

- [ ] **Step 1: Edit `scan.ts`**

Add imports:

```ts
import { crawlPatterns } from "@jobfinder/db";
import { crawlPatternSpecSchema } from "@jobfinder/shared";
import { crawlerClientFromEnv } from "@jobfinder/job-sources";
```

Replace the `createConnector(provider, {...})` call inside `scanSourceWithDb` with:

```ts
const provider = providerName(source.provider);
let pattern = options.connectorOptions?.pattern;
if (provider === "CapturedApi" && !pattern) {
  const [row] = await db
    .select()
    .from(crawlPatterns)
    .where(eq(crawlPatterns.sourceId, source.id));
  if (!row)
    throw new AppError(
      409,
      "This source has no saved API pattern. Retry the company import.",
    );
  pattern = crawlPatternSpecSchema.parse({
    urlTemplate: row.urlTemplate,
    method: row.method,
    headers: row.headers,
    body: row.body,
    jobsPath: row.jobsPath,
    fieldMap: row.fieldMap,
  });
}
const connector = createConnector(provider, {
  ...options.connectorOptions,
  pattern,
  crawlerClient:
    options.connectorOptions?.crawlerClient === undefined
      ? crawlerClientFromEnv()
      : options.connectorOptions.crawlerClient,
  jsonLdAllowedHosts:
    options.connectorOptions?.jsonLdAllowedHosts ??
    (process.env.JSON_LD_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
});
```

After a `Succeeded` finish for a `CapturedApi` source, mark the pattern verified:

```ts
if (provider === "CapturedApi")
  await db
    .update(crawlPatterns)
    .set({ lastVerifiedAt: new Date(), failures: 0 })
    .where(eq(crawlPatterns.sourceId, source.id));
```

Place it just before the `return await finishRun(db, run.id, { status: "Succeeded", ...` inside the `if (!page.notModified)` block.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
npm run format && npm run lint
git add packages/automation/src/scan.ts
git commit -m "Load saved API patterns and the crawler client in the scan engine

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The resolver ladder (pure, injected dependencies)

**Files:**

- Create: `packages/discovery/src/resolve.ts`
- Modify: `packages/discovery/src/index.ts`
- Test: `tests/unit/discovery.test.ts` (append)

**Interfaces:**

- Consumes: `RobotsCache`, `findCareersPage`, `detectAts`, `extractJsonLdJobs`, `collectPostingLinks`, `buildPatternSpec`, `validatePattern`, `CrawlerClient`, `CrawlerRequestError`, `RobotsBlockedError`, `isSupportedAts`, `PolicyCheck`, `CrawlPatternSpec`.
- Produces:

```ts
export type Resolution =
  | {
      status: "Resolved";
      strategy: "ats";
      careersUrl: string;
      ats: SupportedAts;
      atsKey: string;
      policy: PolicyCheck;
    }
  | {
      status: "Resolved";
      strategy: "json-ld";
      careersUrl: string;
      policy: PolicyCheck;
    }
  | {
      status: "Resolved";
      strategy: "captured-api";
      careersUrl: string;
      pattern: CrawlPatternSpec;
      policy: PolicyCheck;
    }
  | {
      status: "Resolved";
      strategy: "browser";
      careersUrl: string;
      policy: PolicyCheck;
    }
  | {
      status: "Unsupported";
      careersUrl: string;
      ats: DetectableAts;
      atsKey: string;
      policy: PolicyCheck;
      error: string;
    }
  | {
      status: "NoCareersPage" | "Blocked" | "Failed";
      careersUrl: string | null;
      policy: PolicyCheck | null;
      error: string;
    };

export interface LadderDeps {
  fetchImpl?: typeof fetch;
  resolveHost?: TransportOptions["resolveHost"];
  crawlerClient: CrawlerClient | null;
  signal?: AbortSignal;
}
export function resolveLadder(
  input: { domain: string; name: string },
  deps: LadderDeps,
): Promise<Resolution>;
```

- [ ] **Step 1: Failing tests**

```ts
import { resolveLadder, type Resolution } from "@jobfinder/discovery";

const ladderFetch = (
  careersHtml: string,
  extra: Record<string, () => Response> = {},
) =>
  routeFetch({
    "https://acme.example/robots.txt": () => new Response("", { status: 404 }),
    "https://acme.example/": () =>
      new Response(`<a href="/careers">Careers</a>`),
    "https://acme.example/careers": () => new Response(careersHtml),
    ...extra,
  });

const resolve = (
  fetchImpl: typeof fetch,
  crawlerClient: CrawlerClient | null = null,
) =>
  resolveLadder(
    { domain: "acme.example", name: "Acme" },
    { fetchImpl, resolveHost: publicHost, crawlerClient },
  );

describe("Phase 5 resolver ladder", () => {
  it("prefers a supported ATS over everything else", async () => {
    const result = await resolve(ladderFetch(fixture("greenhouse-embed.html")));
    expect(result).toMatchObject({
      status: "Resolved",
      strategy: "ats",
      ats: "Greenhouse",
      atsKey: "acmecorp",
      careersUrl: "https://acme.example/careers",
    });
  });

  it("records unsupported vendors without creating a strategy", async () => {
    const result = await resolve(
      routeFetch({
        "https://acme.example/robots.txt": () =>
          new Response("", { status: 404 }),
        "https://acme.example/": () =>
          new Response(`<a href="/careers">Careers</a>`),
        "https://acme.example/careers": () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "https://acme.wd5.myworkdayjobs.com/External",
            },
          }),
        "https://acme.wd5.myworkdayjobs.com/robots.txt": () =>
          new Response("", { status: 404 }),
        "https://acme.wd5.myworkdayjobs.com/External": () =>
          new Response("<p>Workday</p>"),
      }),
    );
    expect(result).toMatchObject({
      status: "Unsupported",
      ats: "Workday",
      atsKey: "acme",
    });
  });

  it("chooses JSON-LD when the listing or its postings carry JobPosting data", async () => {
    const result = await resolve(
      ladderFetch(`<a href="/jobs/1">One</a>`, {
        "https://acme.example/jobs/1": () => new Response(posting("1")),
      }),
    );
    expect(result).toMatchObject({ status: "Resolved", strategy: "json-ld" });
  });

  it("fails before the browser rungs when no crawler is configured", async () => {
    const result = await resolve(ladderFetch(`<div id="app"></div>`));
    expect(result).toMatchObject({
      status: "Failed",
      error: "Crawler service unavailable",
    });
  });

  it("saves a validated captured pattern, else falls back to browser", async () => {
    const sample = [
      { id: 1, title: "Role", url: "https://acme.example/jobs/1" },
    ];
    const capturing: CrawlerClient = {
      capture: async () => ({
        patterns: [
          {
            url: "https://acme.example/api/jobs?page=1",
            method: "GET",
            headers: { accept: "application/json" },
            body: null,
            jobsPath: "/data",
            sample,
          },
        ],
        warnings: [],
      }),
      crawl: async () => ({ jobs: [], complete: true, warnings: [] }),
    };
    const withApi = await resolve(
      ladderFetch(`<div id="app"></div>`, {
        "https://acme.example/api/jobs?page=1": () =>
          new Response(JSON.stringify({ data: sample })),
      }),
      capturing,
    );
    expect(withApi).toMatchObject({
      status: "Resolved",
      strategy: "captured-api",
      pattern: { urlTemplate: "https://acme.example/api/jobs?page={page}" },
    });
    const empty: CrawlerClient = {
      ...capturing,
      capture: async () => ({ patterns: [], warnings: [] }),
    };
    const browser = await resolve(ladderFetch(`<div id="app"></div>`), empty);
    expect(browser).toMatchObject({ status: "Resolved", strategy: "browser" });
  });

  it("reports robots refusals as Blocked with the matched rule", async () => {
    const result = await resolve(
      routeFetch({
        "https://acme.example/robots.txt": () =>
          new Response("User-agent: *\nDisallow: /\n"),
      }),
    );
    expect(result).toMatchObject({ status: "Blocked" });
    expect(
      (result as Extract<Resolution, { status: "Blocked" }>).error,
    ).toContain("Disallow: /");
  });
});
```

The `posting` helper is defined in `tests/unit/discovery-connectors.test.ts`; copy it into `tests/unit/discovery.test.ts` verbatim (tests are independent files).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL, `resolveLadder` not exported.

- [ ] **Step 3: Write `packages/discovery/src/resolve.ts`**

```ts
import {
  collectPostingLinks,
  CrawlerRequestError,
  extractJsonLdJobs,
  fetchText,
  type CrawlerClient,
  type TransportOptions,
} from "@jobfinder/job-sources";
import {
  isSupportedAts,
  type CrawlPatternSpec,
  type DetectableAts,
  type PolicyCheck,
  type SupportedAts,
} from "@jobfinder/shared";
import { detectAts } from "./ats";
import { findCareersPage } from "./careers";
import { buildPatternSpec, validatePattern } from "./patterns";
import { RobotsBlockedError } from "./robots";
import { RobotsCache, type DiscoveryFetchResult } from "./transport";

export type Resolution =
  | {
      status: "Resolved";
      strategy: "ats";
      careersUrl: string;
      ats: SupportedAts;
      atsKey: string;
      policy: PolicyCheck;
    }
  | {
      status: "Resolved";
      strategy: "json-ld";
      careersUrl: string;
      policy: PolicyCheck;
    }
  | {
      status: "Resolved";
      strategy: "captured-api";
      careersUrl: string;
      pattern: CrawlPatternSpec;
      policy: PolicyCheck;
    }
  | {
      status: "Resolved";
      strategy: "browser";
      careersUrl: string;
      policy: PolicyCheck;
    }
  | {
      status: "Unsupported";
      careersUrl: string;
      ats: DetectableAts;
      atsKey: string;
      policy: PolicyCheck;
      error: string;
    }
  | {
      status: "NoCareersPage" | "Blocked" | "Failed";
      careersUrl: string | null;
      policy: PolicyCheck | null;
      error: string;
    };

export interface LadderDeps {
  fetchImpl?: typeof fetch;
  resolveHost?: TransportOptions["resolveHost"];
  crawlerClient: CrawlerClient | null;
  signal?: AbortSignal;
}

const jsonLdProbeLimit = 3;

/** Cheap check: JSON-LD on the listing page, else on up to three posting pages. */
async function hasJsonLd(
  page: DiscoveryFetchResult,
  transport: TransportOptions,
): Promise<boolean> {
  if (extractJsonLdJobs(page.text).length) return true;
  const links = collectPostingLinks(page.text, page.finalUrl, jsonLdProbeLimit);
  for (const link of links) {
    try {
      const { response, text } = await fetchText(link, {}, transport);
      if (response.ok && extractJsonLdJobs(text).length) return true;
    } catch {
      // A single unreadable posting page does not decide the strategy.
    }
  }
  return false;
}

/**
 * The fixed preference ladder from the architecture document. Pure apart from
 * the injected transport and crawler client, so every branch is unit-tested
 * with fixtures and a fake crawler.
 */
export async function resolveLadder(
  input: { domain: string; name: string },
  deps: LadderDeps,
): Promise<Resolution> {
  const transport: TransportOptions = {
    fetchImpl: deps.fetchImpl,
    resolveHost: deps.resolveHost,
    signal: deps.signal,
  };
  const robots = new RobotsCache(transport);
  let careersUrl: string | null = null;
  let policy: PolicyCheck | null = null;
  try {
    const page = await findCareersPage(input.domain, { ...transport, robots });
    if (!page)
      return {
        status: "NoCareersPage",
        careersUrl: null,
        policy: null,
        error: "No careers page was found on the homepage or the usual paths.",
      };
    careersUrl = page.finalUrl.href;
    policy = await robots.check(page.finalUrl);

    const detected = detectAts({
      finalUrl: page.finalUrl,
      chain: page.chain,
      html: page.text,
    });
    if (detected) {
      if (isSupportedAts(detected.ats))
        return {
          status: "Resolved",
          strategy: "ats",
          careersUrl,
          ats: detected.ats,
          atsKey: detected.key,
          policy,
        };
      return {
        status: "Unsupported",
        careersUrl,
        ats: detected.ats,
        atsKey: detected.key,
        policy,
        error: `${detected.ats} was recognised but has no connector yet.`,
      };
    }

    if (await hasJsonLd(page, transport))
      return { status: "Resolved", strategy: "json-ld", careersUrl, policy };

    if (!deps.crawlerClient)
      return {
        status: "Failed",
        careersUrl,
        policy,
        error: "Crawler service unavailable",
      };

    const captured = await deps.crawlerClient.capture(
      { url: careersUrl },
      deps.signal,
    );
    for (const hit of captured.patterns) {
      const spec = buildPatternSpec(hit);
      if (!spec) continue;
      const verdict = await validatePattern(spec, transport);
      if (verdict.ok)
        return {
          status: "Resolved",
          strategy: "captured-api",
          careersUrl,
          pattern: spec,
          policy,
        };
    }
    return { status: "Resolved", strategy: "browser", careersUrl, policy };
  } catch (error) {
    if (error instanceof RobotsBlockedError)
      return {
        status: "Blocked",
        careersUrl: error.url,
        policy: {
          robotsAllowed: false,
          robotsUrl: `https://${new URL(error.url).hostname}/robots.txt`,
          checkedAt: new Date().toISOString(),
          userAgent: "JobFinderBot/1.0",
          matchedRule: error.matchedRule,
        },
        error: `robots.txt disallows ${error.url} (${error.matchedRule})`,
      };
    if (error instanceof CrawlerRequestError)
      return {
        status:
          error.kind === "blocked" || error.kind === "captcha"
            ? "Blocked"
            : "Failed",
        careersUrl,
        policy,
        error: error.message,
      };
    return {
      status: "Failed",
      careersUrl,
      policy,
      error: error instanceof Error ? error.message : "Resolution failed",
    };
  }
}
```

- [ ] **Step 4: Export, run, commit**

Add `export * from "./resolve";` to the index.

Run: `npx vitest run`
Expected: PASS.

```bash
npm run format && npm run lint && npm run typecheck
git add packages/discovery tests/unit/discovery.test.ts
git commit -m "Add the pure company resolver ladder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Company candidate service in `packages/automation`

**Files:**

- Create: `packages/automation/src/companies.ts`
- Modify: `packages/automation/src/index.ts` (`export * from "./companies";`), `packages/automation/package.json` is unchanged (workspace deps resolve by name; add `@jobfinder/discovery` import only)
- Test: `tests/e2e/companies.spec.ts` (append)

**Interfaces:**

- Consumes: `companyCandidates`, `crawlPatterns`, `companyWatchlists`, `jobSources`, `searchRuns` tables; `parseSeedList`, `Resolution`; `watchlistKey`, `sourceIdentity`, `nextRunFor`.
- Produces:
  - `importCompanies(db, userId, text): Promise<{ imported: number; duplicates: number; rejected: { line: number; reason: string }[] }>`
  - `listCompanies(db, userId): Promise<Array<{ candidate: CandidateRow; source: SourceRow | null; lastRun: SearchRunRow | null }>>`
  - `retryCompany(db, userId, id): Promise<CandidateRow>` (allowed from `Failed`, `NoCareersPage`, `Blocked`, `Unsupported`, `Resolved`)
  - `deleteCompany(db, userId, id): Promise<{ id: string }>` (disables the source, like watchlist removal)
  - `claimPendingCandidates(db, now = new Date(), limit = 10): Promise<{ id: string; userId: string }[]>` — claims `Pending`, or `Resolving` older than 15 minutes; sets `Resolving`, `attempts + 1`, `lastCheckedAt`.
  - `applyResolution(db, candidateId, resolution): Promise<CandidateRow>`
  - `recordSourceFailure(db, sourceId): Promise<{ reResolve: boolean }>` — after 3 consecutive `Failed` runs, resets the linked candidate to `Pending`; increments `crawl_patterns.failures`.
  - `resolveRetryAfterFailures = 3`.

- [ ] **Step 1: Failing real-DB tests**

Append to `tests/e2e/companies.spec.ts` (add the imports at the top of the file):

```ts
import { randomUUID } from "node:crypto";
import { getDb } from "@jobfinder/db";
import {
  applyResolution,
  claimPendingCandidates,
  importCompanies,
  listCompanies,
  recordSourceFailure,
} from "@jobfinder/automation";

const newUser = async (pool: Pool, label: string) => {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id",
    [`${label}-${randomUUID()}@example.test`, label],
  );
  return rows[0].id;
};

const cleanup = async (pool: Pool, userId: string) => {
  await pool.query("DELETE FROM company_candidates WHERE user_id=$1", [userId]);
  await pool.query(
    "DELETE FROM job_references WHERE job_id IN (SELECT id FROM jobs WHERE owner_id=$1)",
    [userId],
  );
  await pool.query("DELETE FROM search_runs WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM company_watchlists WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM job_sources WHERE owner_id=$1", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
};

test("importing companies creates linked watchlist entries and pending candidates once", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const userId = await newUser(pool, "import");
  try {
    const db = getDb();
    const first = await importCompanies(
      db,
      userId,
      "Acme, acme.example\nbeta.example\nnot a domain",
    );
    expect(first).toEqual({
      imported: 2,
      duplicates: 0,
      rejected: [{ line: 3, reason: "No domain found" }],
    });
    const again = await importCompanies(
      db,
      userId,
      "https://www.acme.example/jobs",
    );
    expect(again.duplicates).toBe(1);
    const listed = await listCompanies(db, userId);
    expect(listed.map((row) => row.candidate.domain)).toEqual([
      "acme.example",
      "beta.example",
    ]);
    const watch = await pool.query<{ company: string; domain: string }>(
      "SELECT company, domain FROM company_watchlists WHERE user_id=$1 ORDER BY company",
      [userId],
    );
    expect(watch.rows).toEqual([
      { company: "Acme", domain: "acme.example" },
      { company: "beta.example", domain: "beta.example" },
    ]);
    const claimed = await claimPendingCandidates(db);
    expect(claimed.filter((c) => c.userId === userId)).toHaveLength(2);
    expect(await claimPendingCandidates(db)).toEqual(
      expect.not.arrayContaining(claimed),
    );
  } finally {
    await cleanup(pool, userId);
    await pool.end();
  }
});

test("applying resolutions creates sources per strategy and failures trigger re-resolution", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const userId = await newUser(pool, "resolve");
  try {
    const db = getDb();
    await importCompanies(
      db,
      userId,
      "gh.example\napi.example\nbrowser.example\nnone.example",
    );
    const rows = await listCompanies(db, userId);
    const byDomain = (domain: string) =>
      rows.find((r) => r.candidate.domain === domain)!.candidate.id;
    const policy = {
      robotsAllowed: true,
      robotsUrl: "https://x/robots.txt",
      checkedAt: new Date().toISOString(),
      userAgent: "JobFinderBot/1.0",
    };

    const ats = await applyResolution(db, byDomain("gh.example"), {
      status: "Resolved",
      strategy: "ats",
      careersUrl: "https://gh.example/careers",
      ats: "Greenhouse",
      atsKey: "ghco",
      policy,
    });
    expect(ats.status).toBe("Resolved");
    const ghSource = await pool.query<{
      provider: string;
      board: string;
      schedule: string;
    }>("SELECT provider, board, schedule FROM job_sources WHERE id=$1", [
      ats.sourceId,
    ]);
    expect(ghSource.rows[0]).toEqual({
      provider: "Greenhouse",
      board: "ghco",
      schedule: "Every 4 hours",
    });
    const watch = await pool.query<{
      provider: string;
      board: string;
      source_id: string;
    }>(
      "SELECT provider, board, source_id FROM company_watchlists WHERE id=$1",
      [ats.watchlistId],
    );
    expect(watch.rows[0]).toEqual({
      provider: "Greenhouse",
      board: "ghco",
      source_id: ats.sourceId,
    });

    const api = await applyResolution(db, byDomain("api.example"), {
      status: "Resolved",
      strategy: "captured-api",
      careersUrl: "https://api.example/careers",
      policy,
      pattern: {
        urlTemplate: "https://api.example/api/jobs?page={page}",
        method: "GET",
        headers: {},
        body: null,
        jobsPath: "/data",
        fieldMap: { title: "/title", url: "/url" },
      },
    });
    const pattern = await pool.query<{ url_template: string }>(
      "SELECT url_template FROM crawl_patterns WHERE source_id=$1",
      [api.sourceId],
    );
    expect(pattern.rows[0].url_template).toContain("{page}");

    const browser = await applyResolution(db, byDomain("browser.example"), {
      status: "Resolved",
      strategy: "browser",
      careersUrl: "https://browser.example/careers",
      policy,
    });
    const browserSource = await pool.query<{
      provider: string;
      source_url: string;
    }>("SELECT provider, source_url FROM job_sources WHERE id=$1", [
      browser.sourceId,
    ]);
    expect(browserSource.rows[0]).toEqual({
      provider: "Browser",
      source_url: "https://browser.example/careers",
    });

    const none = await applyResolution(db, byDomain("none.example"), {
      status: "NoCareersPage",
      careersUrl: null,
      policy: null,
      error: "No careers page was found on the homepage or the usual paths.",
    });
    expect(none).toMatchObject({
      status: "NoCareersPage",
      sourceId: null,
      strategy: "none",
    });

    for (let i = 0; i < 3; i++)
      await pool.query(
        "INSERT INTO search_runs (source_id, user_id, status, error) VALUES ($1, $2, 'Failed', 'boom')",
        [api.sourceId, userId],
      );
    expect(await recordSourceFailure(db, api.sourceId!)).toEqual({
      reResolve: true,
    });
    const reset = await pool.query<{ status: string; failures: number }>(
      `SELECT c.status, p.failures FROM company_candidates c JOIN crawl_patterns p ON p.source_id=c.source_id WHERE c.id=$1`,
      [api.id],
    );
    expect(reset.rows[0]).toEqual({ status: "Pending", failures: 1 });
  } finally {
    await cleanup(pool, userId);
    await pool.end();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx playwright test tests/e2e/companies.spec.ts`
Expected: FAIL, `importCompanies` not exported from `@jobfinder/automation`.

- [ ] **Step 3: Write `packages/automation/src/companies.ts`**

```ts
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  companyCandidates,
  companyWatchlists,
  crawlPatterns,
  jobSources,
  searchRuns,
} from "@jobfinder/db";
import { parseSeedList, type Resolution } from "@jobfinder/discovery";
import {
  AppError,
  watchlistKey,
  type CandidateStatus,
  type CrawlStrategy,
} from "@jobfinder/shared";
import { nextRunFor } from "./schedule";
import { sourceIdentity, type AutomationDb } from "./scan";

export type CandidateRow = typeof companyCandidates.$inferSelect;
export const resolveRetryAfterFailures = 3;
const resolvingStaleMs = 15 * 60_000;
const recheckAfterMs = 30 * 86_400_000;
const defaultSchedule = "Every 4 hours" as const;

/**
 * Each pasted or uploaded row becomes a watchlist entry plus a Pending
 * candidate. The worker's scheduler tick picks Pending rows up, so the web
 * app never talks to pg-boss.
 */
export async function importCompanies(
  db: AutomationDb,
  userId: string,
  text: string,
) {
  const parsed = parseSeedList(text);
  let imported = 0;
  let duplicates = 0;
  for (const row of parsed.rows) {
    const [existing] = await db
      .select({ id: companyCandidates.id })
      .from(companyCandidates)
      .where(
        and(
          eq(companyCandidates.userId, userId),
          eq(companyCandidates.domain, row.domain),
        ),
      );
    if (existing) {
      duplicates++;
      continue;
    }
    await db.transaction(async (tx) => {
      const key = watchlistKey(row.name);
      const [watch] = await tx
        .insert(companyWatchlists)
        .values({
          userId,
          company: row.name,
          companyKey: key,
          domain: row.domain,
          priority: "Interesting",
        })
        .onConflictDoNothing({
          target: [companyWatchlists.userId, companyWatchlists.companyKey],
        })
        .returning({ id: companyWatchlists.id });
      const watchlistId =
        watch?.id ??
        (
          await tx
            .select({ id: companyWatchlists.id })
            .from(companyWatchlists)
            .where(
              and(
                eq(companyWatchlists.userId, userId),
                eq(companyWatchlists.companyKey, key),
              ),
            )
        )[0]?.id ??
        null;
      await tx
        .insert(companyCandidates)
        .values({
          userId,
          watchlistId,
          name: row.name,
          domain: row.domain,
          status: "Pending",
        });
    });
    imported++;
  }
  return { imported, duplicates, rejected: parsed.rejected };
}

export async function listCompanies(db: AutomationDb, userId: string) {
  const rows = await db
    .select({ candidate: companyCandidates, source: jobSources })
    .from(companyCandidates)
    .leftJoin(jobSources, eq(jobSources.id, companyCandidates.sourceId))
    .where(eq(companyCandidates.userId, userId))
    .orderBy(asc(companyCandidates.name));
  const sourceIds = rows
    .map((r) => r.source?.id)
    .filter((id): id is string => Boolean(id));
  const runs = sourceIds.length
    ? await db
        .select()
        .from(searchRuns)
        .where(inArray(searchRuns.sourceId, sourceIds))
        .orderBy(desc(searchRuns.startedAt))
    : [];
  return rows.map(({ candidate, source }) => ({
    candidate,
    source: source ?? null,
    lastRun: source
      ? (runs.find((run) => run.sourceId === source.id) ?? null)
      : null,
  }));
}

async function ownedCandidate(db: AutomationDb, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(companyCandidates)
    .where(
      and(eq(companyCandidates.id, id), eq(companyCandidates.userId, userId)),
    );
  if (!row) throw new AppError(404, "Company not found.");
  return row;
}

export async function retryCompany(
  db: AutomationDb,
  userId: string,
  id: string,
) {
  const row = await ownedCandidate(db, userId, id);
  if (row.status === "Resolving" || row.status === "Pending")
    throw new AppError(409, "This company is already waiting for the worker.");
  const [updated] = await db
    .update(companyCandidates)
    .set({
      status: "Pending",
      error: "",
      nextCheckAt: null,
      updatedAt: new Date(),
    })
    .where(eq(companyCandidates.id, id))
    .returning();
  return updated;
}

export async function deleteCompany(
  db: AutomationDb,
  userId: string,
  id: string,
) {
  const row = await ownedCandidate(db, userId, id);
  await db.delete(companyCandidates).where(eq(companyCandidates.id, id));
  if (row.sourceId)
    await db
      .update(jobSources)
      .set({ enabled: false, schedule: "Manual", nextRunAt: null })
      .where(
        and(eq(jobSources.id, row.sourceId), eq(jobSources.ownerId, userId)),
      );
  return { id };
}

/** Claims Pending rows (or stale Resolving ones) so a duplicated tick cannot double-resolve. */
export async function claimPendingCandidates(
  db: AutomationDb,
  now = new Date(),
  limit = 10,
) {
  const stale = new Date(now.getTime() - resolvingStaleMs);
  const due = await db
    .select({ id: companyCandidates.id, userId: companyCandidates.userId })
    .from(companyCandidates)
    .where(
      or(
        and(
          eq(companyCandidates.status, "Pending"),
          or(
            isNull(companyCandidates.nextCheckAt),
            lt(companyCandidates.nextCheckAt, now),
          ),
        ),
        and(
          eq(companyCandidates.status, "Resolving"),
          lt(companyCandidates.lastCheckedAt, stale),
        ),
      ),
    )
    .orderBy(asc(companyCandidates.createdAt))
    .limit(limit);
  const claimed: { id: string; userId: string }[] = [];
  for (const row of due) {
    const [updated] = await db
      .update(companyCandidates)
      .set({
        status: "Resolving",
        attempts: sql`${companyCandidates.attempts} + 1`,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(companyCandidates.id, row.id),
          inArray(companyCandidates.status, ["Pending", "Resolving"]),
        ),
      )
      .returning({ id: companyCandidates.id });
    if (updated) claimed.push(row);
  }
  return claimed;
}

async function ensureSource(
  db: AutomationDb,
  candidate: CandidateRow,
  input: { provider: string; board: string; sourceUrl: string | null },
) {
  const identity = sourceIdentity({
    provider: input.provider,
    board: input.board,
    sourceUrl: input.sourceUrl,
  });
  const values = {
    ownerId: candidate.userId,
    identity,
    company: candidate.name,
    provider: input.provider,
    board: input.board,
    sourceUrl: input.sourceUrl,
    enabled: true,
    schedule: defaultSchedule,
    nextRunAt: nextRunFor(defaultSchedule, new Date()),
  };
  const [created] = await db
    .insert(jobSources)
    .values(values)
    .onConflictDoNothing({ target: [jobSources.ownerId, jobSources.identity] })
    .returning({ id: jobSources.id });
  if (created) return created.id;
  const [existing] = await db
    .select({ id: jobSources.id })
    .from(jobSources)
    .where(
      and(
        eq(jobSources.ownerId, candidate.userId),
        eq(jobSources.identity, identity),
      ),
    );
  await db
    .update(jobSources)
    .set({
      enabled: true,
      company: candidate.name,
      sourceUrl: input.sourceUrl,
      schedule: defaultSchedule,
      nextRunAt: values.nextRunAt,
    })
    .where(eq(jobSources.id, existing.id));
  return existing.id;
}

/**
 * Persists one ladder outcome. A resolved strategy creates or re-enables the
 * matching source, links it to the candidate and its watchlist entry, and
 * disables a previous source when the strategy changed.
 */
export async function applyResolution(
  db: AutomationDb,
  candidateId: string,
  resolution: Resolution,
): Promise<CandidateRow> {
  const [candidate] = await db
    .select()
    .from(companyCandidates)
    .where(eq(companyCandidates.id, candidateId));
  if (!candidate) throw new AppError(404, "Company not found.");
  const now = new Date();
  const base = {
    status: resolution.status as CandidateStatus,
    careersUrl: resolution.careersUrl,
    policyCheck: resolution.policy ?? null,
    lastCheckedAt: now,
    updatedAt: now,
  };
  if (resolution.status !== "Resolved") {
    const ats =
      resolution.status === "Unsupported"
        ? { ats: resolution.ats, atsKey: resolution.atsKey }
        : {};
    const [row] = await db
      .update(companyCandidates)
      .set({
        ...base,
        ...ats,
        strategy: "none",
        sourceId: null,
        error: resolution.error,
        nextCheckAt: null,
      })
      .where(eq(companyCandidates.id, candidateId))
      .returning();
    if (candidate.sourceId)
      await db
        .update(jobSources)
        .set({ enabled: false, schedule: "Manual", nextRunAt: null })
        .where(eq(jobSources.id, candidate.sourceId));
    return row;
  }

  let sourceId: string;
  let ats: { ats: string | null; atsKey: string | null } = {
    ats: null,
    atsKey: null,
  };
  if (resolution.strategy === "ats") {
    sourceId = await ensureSource(db, candidate, {
      provider: resolution.ats,
      board: resolution.atsKey,
      sourceUrl: null,
    });
    ats = { ats: resolution.ats, atsKey: resolution.atsKey };
    if (candidate.watchlistId)
      await db
        .update(companyWatchlists)
        .set({
          provider: resolution.ats,
          board: resolution.atsKey,
          updatedAt: now,
        })
        .where(eq(companyWatchlists.id, candidate.watchlistId));
  } else {
    const provider =
      resolution.strategy === "json-ld"
        ? "Careers"
        : resolution.strategy === "captured-api"
          ? "CapturedApi"
          : "Browser";
    sourceId = await ensureSource(db, candidate, {
      provider,
      board: candidate.domain,
      sourceUrl: resolution.careersUrl,
    });
    if (resolution.strategy === "captured-api") {
      const pattern = resolution.pattern;
      await db
        .insert(crawlPatterns)
        .values({
          sourceId,
          urlTemplate: pattern.urlTemplate,
          method: pattern.method,
          headers: pattern.headers,
          body: pattern.body,
          jobsPath: pattern.jobsPath,
          fieldMap: pattern.fieldMap,
          lastVerifiedAt: now,
          failures: 0,
        })
        .onConflictDoUpdate({
          target: crawlPatterns.sourceId,
          set: {
            urlTemplate: pattern.urlTemplate,
            method: pattern.method,
            headers: pattern.headers,
            body: pattern.body,
            jobsPath: pattern.jobsPath,
            fieldMap: pattern.fieldMap,
            lastVerifiedAt: now,
            failures: 0,
            discoveredAt: now,
          },
        });
    }
  }
  if (candidate.sourceId && candidate.sourceId !== sourceId)
    await db
      .update(jobSources)
      .set({ enabled: false, schedule: "Manual", nextRunAt: null })
      .where(eq(jobSources.id, candidate.sourceId));
  if (candidate.watchlistId)
    await db
      .update(companyWatchlists)
      .set({ sourceId, updatedAt: now })
      .where(eq(companyWatchlists.id, candidate.watchlistId));
  const [row] = await db
    .update(companyCandidates)
    .set({
      ...base,
      ...ats,
      strategy: resolution.strategy as CrawlStrategy,
      sourceId,
      error: "",
      nextCheckAt: new Date(now.getTime() + recheckAfterMs),
    })
    .where(eq(companyCandidates.id, candidateId))
    .returning();
  return row;
}

/**
 * Called by the worker after a failed scan. Three consecutive failures send
 * the candidate back to Pending so a moved page or a cheaper rung is found.
 */
export async function recordSourceFailure(
  db: AutomationDb,
  sourceId: string,
): Promise<{ reResolve: boolean }> {
  await db
    .update(crawlPatterns)
    .set({ failures: sql`${crawlPatterns.failures} + 1` })
    .where(eq(crawlPatterns.sourceId, sourceId));
  const recent = await db
    .select({ status: searchRuns.status })
    .from(searchRuns)
    .where(eq(searchRuns.sourceId, sourceId))
    .orderBy(desc(searchRuns.startedAt))
    .limit(resolveRetryAfterFailures);
  const exhausted =
    recent.length === resolveRetryAfterFailures &&
    recent.every((run) => run.status === "Failed");
  if (!exhausted) return { reResolve: false };
  const updated = await db
    .update(companyCandidates)
    .set({
      status: "Pending",
      error: `Re-resolving after ${resolveRetryAfterFailures} failed scans.`,
      nextCheckAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(companyCandidates.sourceId, sourceId),
        eq(companyCandidates.status, "Resolved"),
      ),
    )
    .returning({ id: companyCandidates.id });
  return { reResolve: updated.length > 0 };
}
```

- [ ] **Step 4: Export, run, commit**

Add `export * from "./companies";` to `packages/automation/src/index.ts`.

Run: `npm run typecheck && npm run build && npx playwright test tests/e2e/companies.spec.ts`
Expected: PASS (3 tests).

```bash
npm run format && npm run lint
git add packages/automation tests/e2e/companies.spec.ts
git commit -m "Add company candidate import, listing and resolution persistence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
