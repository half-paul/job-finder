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

import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { getDb } from "@jobfinder/db";
import {
  claimCompany,
  deleteWatchlist,
  importCompanies,
  listActivity,
  recordActivities,
  listCompanies,
  pendingCompanies,
  scanSourceWithDb,
} from "@jobfinder/automation";
import {
  runResolveCompanyJob,
  runScanJob,
} from "../../apps/worker/src/handlers";
const headers = { Origin: "http://localhost:3000" };
async function register(request: APIRequestContext) {
  const response = await request.post("/api/auth/register", {
    headers,
    data: {
      email: `companies-${randomUUID()}@example.test`,
      password: "Company workflow testing 123!",
      name: "Company workflow fixture",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string };
}
async function cleanup(pool: Pool, id: string) {
  await pool.query(
    "DELETE FROM job_references WHERE source_id IN (SELECT id FROM job_sources WHERE owner_id=$1)",
    [id],
  );
  await pool.query("DELETE FROM search_runs WHERE user_id=$1", [id]);
  await pool.query("DELETE FROM company_candidates WHERE user_id=$1", [id]);
  await pool.query("DELETE FROM company_watchlists WHERE user_id=$1", [id]);
  await pool.query("DELETE FROM job_sources WHERE owner_id=$1", [id]);
  await pool.query("DELETE FROM users WHERE id=$1", [id]);
}
const fixtureFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("robots.txt")) return new Response("", { status: 404 });
  if (url === "https://fixture.example/")
    return new Response('<a href="/careers">Careers</a>');
  if (url === "https://fixture.example/careers")
    return new Response(
      '<a href="/careers/corporate">Corporate opportunities</a>',
    );
  if (url === "https://fixture.example/careers/corporate")
    return new Response(
      '<a href="https://boards.greenhouse.io/fixture">Open positions</a>',
    );
  return new Response("missing", { status: 404 });
}) as typeof fetch;

test("activity paging does not skip rows written in one batch", async ({
  request,
}) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const user = await register(request);
  try {
    // One insert gives every row the same created_at, which is exactly what a
    // bulk import produces. A created_at-only cursor dropped the rest of the
    // batch at the page boundary.
    await recordActivities(
      getDb(),
      Array.from({ length: 150 }, (_, index) => ({
        userId: user.id,
        actor: "Application" as const,
        stage: "queued",
        message: `batched row ${index}`,
      })),
    );
    const first = await listActivity(getDb(), user.id);
    expect(first).toHaveLength(100);
    const older = await listActivity(getDb(), user.id, {
      beforeId: first.at(-1)!.id,
    });
    const mine = [...first, ...older].filter((event) =>
      event.message.startsWith("batched row "),
    );
    expect(new Set(mine.map((event) => event.id)).size).toBe(150);
  } finally {
    await pool.query("DELETE FROM activity_events WHERE user_id=$1", [user.id]);
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("bulk import, deduplication, origin checks and activity are owner scoped", async ({
  request,
  playwright,
}) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const user = await register(request);
  const other = await playwright.request.newContext({
    baseURL: "http://localhost:3000",
  });
  const otherUser = await register(other);
  try {
    expect(
      (
        await request.post("/api/companies", {
          data: { name: "Invalid", url: "bad.example" },
        })
      ).status(),
    ).toBe(403);
    const imported = await request.post("/api/companies", {
      headers,
      data: {
        text: 'name,domain\n"Fixture, Inc",fixture.example\nOther,other.example\ninvalid\nFixture,fixture.example',
      },
    });
    expect(imported.status(), await imported.text()).toBe(202);
    expect(await imported.json()).toMatchObject({
      imported: 2,
      duplicates: 0,
      rejected: [{ line: 4 }, { line: 5 }],
    });
    expect(
      (
        await (
          await request.post("/api/companies", {
            headers,
            data: { name: "Fixture", url: "fixture.example" },
          })
        ).json()
      ).duplicates,
    ).toBe(1);
    const rows = (await (await request.get("/api/companies")).json()).companies;
    expect(rows).toHaveLength(2);
    expect(rows[0].candidate.status).toBe("Pending");
    expect(
      (await (await other.get("/api/companies")).json()).companies,
    ).toEqual([]);
    expect(
      (
        await other.delete(`/api/companies/${rows[0].candidate.id}`, {
          headers,
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await other.post(`/api/companies/${rows[0].candidate.id}`, { headers })
      ).status(),
    ).toBe(409);
    const own = await (await request.get("/api/activity")).json();
    expect(
      own.some((event: { stage: string }) => event.stage === "queued"),
    ).toBe(true);
    const foreign = await (await other.get("/api/activity")).json();
    expect(
      foreign.some((event: { userId: string }) => event.userId === user.id),
    ).toBe(false);
    expect(
      (
        await other.get(`/api/activity?candidateId=${rows[0].candidate.id}`)
      ).ok(),
    ).toBe(true);
    expect(
      await (
        await other.get(`/api/activity?candidateId=${rows[0].candidate.id}`)
      ).json(),
    ).toEqual([]);
  } finally {
    await cleanup(pool, user.id);
    await cleanup(pool, otherUser.id);
    await other.dispose();
    await pool.end();
  }
});

test("worker resolves a company, scans its API and records actions with injected fixtures", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await importCompanies(getDb(), user.id, "Fixture,fixture.example");
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    expect(await pendingCompanies(getDb())).toEqual(
      expect.arrayContaining([{ id: candidate.id, userId: user.id }]),
    );
    const result = await runResolveCompanyJob(
      getDb(),
      { data: { candidateId: candidate.id, userId: user.id } },
      { fetchImpl: fixtureFetch },
    );
    expect(result).toEqual({ resolved: true });
    const [resolved] = await listCompanies(getDb(), user.id);
    expect(resolved.candidate).toMatchObject({
      status: "Resolved",
      strategy: "ats",
      ats: "Greenhouse",
    });
    expect(resolved.source?.nextRunAt!.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    const queued: string[] = [];
    const scan = await runScanJob(
      getDb(),
      {
        enqueueEvaluation: async (job) => {
          queued.push(job.userId);
        },
      },
      {
        id: randomUUID(),
        data: {
          userId: user.id,
          sourceId: resolved.source!.id,
          schedule: "Every 4 hours",
        },
      },
      {
        connectorOptions: {
          fetchImpl: (async () =>
            Response.json({
              jobs: [
                {
                  id: 12,
                  title: "Director of Infrastructure",
                  company_name: "Fixture",
                  content:
                    "Lead infrastructure reliability and cloud architecture for our platform.",
                  location: { name: "Canada" },
                  offices: [],
                  absolute_url: "https://boards.greenhouse.io/fixture/jobs/12",
                },
              ],
            })) as typeof fetch,
        },
      },
    );
    expect(scan).toMatchObject({
      status: "Succeeded",
      added: 1,
      evaluationQueued: true,
    });
    expect(queued).toEqual([user.id]);
    const events = await listActivity(getDb(), user.id);
    expect(events.map((event) => event.stage)).toEqual(
      expect.arrayContaining([
        "queued",
        "robots",
        "fetch",
        "http",
        "api",
        "resolved",
        "scan-start",
        // Per-listing "import" rows are no longer persisted; the counts live
        // on the run summary instead.
        "scan-complete",
      ]),
    );
    expect(
      (
        await request.delete(`/api/companies/${candidate.id}`, { headers })
      ).ok(),
    ).toBe(true);
    const source = await pool.query(
      "SELECT enabled FROM job_sources WHERE id=$1",
      [resolved.source!.id],
    );
    expect(source.rows[0].enabled).toBe(false);
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

// Deferred coverage (Task 3 wired scan.ts, Task 5 persisted the pattern row;
// neither had an executable test): resolution producing a `CapturedApi`
// source with its `crawl_patterns` row, and a scan replaying that pattern.
// This drives the same handlers as the test above with an injected
// `crawlerClient` instead of a real crawler container — the real, networked
// capture/crawl path is covered separately by tests/e2e/crawler.spec.ts.
test("worker resolves a company to a captured API, saves its pattern, and a scan replays it", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  const capturedFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://captured-api.example/robots.txt")
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    if (url === "https://captured-api.example/")
      return new Response('<a href="/careers">Careers</a>');
    if (url === "https://captured-api.example/careers")
      return new Response("<html><body>Roles load here</body></html>");
    if (url === "https://captured-api.example/api/jobs?page=1")
      return Response.json({
        results: [{ title: "Director of Infrastructure", url: "/jobs/501" }],
      });
    if (url === "https://captured-api.example/api/jobs?page=2")
      return Response.json({ results: [] });
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  // Stands in for the real crawler service's `/capture` endpoint: one
  // watched page call away from `tests/e2e/crawler.spec.ts`'s equivalent
  // fixture, but exercised here through the same in-process handlers the
  // greenhouse test above uses, against the real dockerized database.
  const crawlerClient = {
    crawl: async () => ({ jobs: [], complete: true, warnings: [] }),
    capture: async () => ({
      patterns: [
        {
          url: "https://captured-api.example/api/jobs?page=1",
          method: "GET" as const,
          headers: { accept: "application/json" },
          body: null,
          jobsPath: "/results",
          sample: [
            {
              title: "Sample Posting",
              url: "https://captured-api.example/jobs/999",
            },
          ],
        },
      ],
      warnings: [],
    }),
  };
  try {
    await importCompanies(getDb(), user.id, "Captured Co,captured-api.example");
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    const result = await runResolveCompanyJob(
      getDb(),
      { data: { candidateId: candidate.id, userId: user.id } },
      { fetchImpl: capturedFetch, crawlerClient },
    );
    expect(result).toEqual({ resolved: true });
    const [resolved] = await listCompanies(getDb(), user.id);
    expect(resolved.candidate).toMatchObject({
      status: "Resolved",
      strategy: "captured-api",
      ats: null,
    });
    expect(resolved.source).toMatchObject({ provider: "CapturedApi" });
    const pattern = await pool.query(
      "SELECT url_template, method, jobs_path, field_map FROM crawl_patterns WHERE source_id=$1",
      [resolved.source!.id],
    );
    expect(pattern.rows).toHaveLength(1);
    expect(pattern.rows[0]).toMatchObject({
      url_template: "https://captured-api.example/api/jobs?page={page}",
      method: "GET",
      jobs_path: "/results",
    });
    expect(pattern.rows[0].field_map).toMatchObject({
      title: "/title",
      url: "/url",
    });
    const queued: string[] = [];
    const scan = await runScanJob(
      getDb(),
      {
        enqueueEvaluation: async (job) => {
          queued.push(job.userId);
        },
      },
      {
        id: randomUUID(),
        data: {
          userId: user.id,
          sourceId: resolved.source!.id,
          schedule: "Every 4 hours",
        },
      },
      { connectorOptions: { fetchImpl: capturedFetch } },
    );
    expect(scan).toMatchObject({
      status: "Succeeded",
      added: 1,
      evaluationQueued: true,
    });
    expect(queued).toEqual([user.id]);
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("claims are exclusive, stale work is recoverable, and robots errors remain visible", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await importCompanies(getDb(), user.id, "Fixture,fixture.example");
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    const claims = await Promise.all([
      claimCompany(getDb(), user.id, candidate.id),
      claimCompany(getDb(), user.id, candidate.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await pool.query(
      "UPDATE company_candidates SET last_checked_at=now()-interval '16 minutes' WHERE id=$1",
      [candidate.id],
    );
    expect(await claimCompany(getDb(), user.id, candidate.id)).toMatchObject({
      attempts: 2,
    });
    await pool.query(
      "UPDATE company_candidates SET status='Pending' WHERE id=$1",
      [candidate.id],
    );
    await runResolveCompanyJob(
      getDb(),
      { data: { userId: user.id, candidateId: candidate.id } },
      {
        fetchImpl: (async () =>
          new Response("User-agent: *\nDisallow: /")) as typeof fetch,
      },
    );
    const [blocked] = await listCompanies(getDb(), user.id);
    expect(blocked.candidate.status).toBe("Blocked");
    expect(blocked.source).toBeNull();
    expect(
      (await request.post(`/api/companies/${candidate.id}`, { headers })).ok(),
    ).toBe(true);
    expect((await listCompanies(getDb(), user.id))[0].candidate.status).toBe(
      "Pending",
    );
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("AI careers fallback persists validated jobs through existing keyword gates", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await importCompanies(
      getDb(),
      user.id,
      "Fixture,https://fixture.example/careers",
    );
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    const fetchImpl = (async (input: RequestInfo | URL) =>
      String(input).endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : new Response(
            "Platform Director. Lead cloud platform reliability and infrastructure architecture.",
          )) as typeof fetch;
    await runResolveCompanyJob(
      getDb(),
      { data: { userId: user.id, candidateId: candidate.id } },
      { fetchImpl },
    );
    const [resolved] = await listCompanies(getDb(), user.id);
    expect(resolved.candidate.strategy).toBe("ai");
    const scan = await scanSourceWithDb(
      {
        userId: user.id,
        sourceId: resolved.source!.id,
        connectorOptions: { fetchImpl },
        extractPage: async () => ({
          jobs: [
            {
              title: "Platform Director",
              url: "https://fixture.example/careers",
              description:
                "Lead cloud platform reliability and infrastructure architecture.",
              location: "",
            },
          ],
          nextUrls: [],
          noOpenings: false,
        }),
      },
      getDb(),
    );
    expect(scan).toMatchObject({ status: "Succeeded", added: 1, removed: 0 });
    expect(
      (await listActivity(getDb(), user.id)).map((event) => event.stage),
    ).toContain("ai");
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("company UI adds with two fields, uploads CSV and shows persisted progress", async ({
  page,
}) => {
  const user = await register(page.request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await page.goto("/companies");
    await expect(
      page.getByRole("heading", { name: "The employers you are tracking." }),
    ).toBeVisible();
    await page.getByLabel("Company name", { exact: true }).fill("UI Fixture");
    await page.getByLabel("Website or careers URL").fill("ui-fixture.example");
    await page
      .getByRole("button", { name: "Add company", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "1 queued" }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "Waiting for worker Not resolved" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Bulk import", exact: true })
      .click();
    await page.getByLabel("CSV or text file").setInputFiles({
      name: "companies.csv",
      mimeType: "text/csv",
      buffer: Buffer.from('name,domain\n"Bulk, Inc",bulk-fixture.example'),
    });
    await page
      .getByRole("button", { name: "Import companies", exact: true })
      .click();
    await expect(
      page.getByRole("cell").filter({ hasText: "Bulk, Inc" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Worker and application activity"),
    ).toContainText("queued for website and careers discovery");
    await page.screenshot({
      path: "test-results/company-workflow-desktop.png",
      fullPage: true,
    });
    await page.reload();
    await expect(
      page.getByRole("cell").filter({ hasText: "UI Fixture" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/company-workflow-mobile.png",
      fullPage: true,
    });
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

import { discoveryExtractor } from "../../packages/automation/src/discovery-ai";
test("AI discovery estimates are persisted and the monthly budget prevents another call", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      "UPDATE career_preferences SET data=jsonb_set(data, '{aiDiscoveryBudgetMicros}', '50000') WHERE user_id=$1",
      [user.id],
    );
    let calls = 0;
    const extract = discoveryExtractor(
      getDb(),
      user.id,
      { actor: "Worker" },
      {
        apiKey: "fixture-key",
        fetchImpl: (async () => {
          calls++;
          return Response.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    jobs: [],
                    nextUrls: [],
                    noOpenings: true,
                  }),
                },
              },
            ],
          });
        }) as typeof fetch,
      },
    );
    const input = {
      url: "https://fixture.example/careers",
      text: "There are no current openings.",
      links: [],
    };
    await extract(input);
    await expect(extract(input)).rejects.toThrow("monthly discovery budget");
    expect(calls).toBe(1);
    const entries = await listActivity(getDb(), user.id);
    expect(
      entries.filter((event) => event.stage === "ai-budget"),
    ).toMatchObject([{ estimatedCostMicros: 50_000, actor: "Worker" }]);
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("the owner can retry a failed company and then remove it, disabling its source", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await importCompanies(getDb(), user.id, "Fixture,fixture.example");
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    await runResolveCompanyJob(
      getDb(),
      { data: { candidateId: candidate.id, userId: user.id } },
      { fetchImpl: fixtureFetch },
    );
    const [resolved] = await listCompanies(getDb(), user.id);
    await pool.query(
      "UPDATE company_candidates SET status='Failed', error='Source scan failed' WHERE id=$1",
      [candidate.id],
    );
    const retried = await request.post(`/api/companies/${candidate.id}`, {
      headers,
    });
    expect(retried.ok(), await retried.text()).toBe(true);
    expect(await retried.json()).toMatchObject({
      status: "Pending",
      error: "",
    });
    const removed = await request.delete(`/api/companies/${candidate.id}`, {
      headers,
    });
    expect(removed.ok(), await removed.text()).toBe(true);
    expect(await listCompanies(getDb(), user.id)).toHaveLength(0);
    const source = await pool.query(
      "SELECT enabled, schedule FROM job_sources WHERE id=$1",
      [resolved.source!.id],
    );
    expect(source.rows[0]).toMatchObject({
      enabled: false,
      schedule: "Manual",
    });
    const watchlist = await pool.query(
      "SELECT id FROM company_watchlists WHERE user_id=$1",
      [user.id],
    );
    expect(watchlist.rowCount).toBe(0);
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("removing a watchlist entry cascades its linked company candidate", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await importCompanies(getDb(), user.id, "Fixture,https://fixture.example/");
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    expect(candidate.watchlistId).not.toBeNull();
    await deleteWatchlist(getDb(), user.id, candidate.watchlistId!);
    expect(await listCompanies(getDb(), user.id)).toHaveLength(0);
    const remaining = await pool.query(
      "SELECT id FROM company_candidates WHERE id=$1",
      [candidate.id],
    );
    expect(remaining.rowCount).toBe(0);
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("scanning a Careers source refuses to run until its candidate is approved", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await importCompanies(getDb(), user.id, "Fixture,https://fixture.example/");
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    const aiFetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : new Response(
            "Platform Director. Lead cloud platform reliability and infrastructure architecture.",
          )) as typeof fetch;
    await runResolveCompanyJob(
      getDb(),
      { data: { userId: user.id, candidateId: candidate.id } },
      { fetchImpl: aiFetch },
    );
    const [resolved] = await listCompanies(getDb(), user.id);
    expect(resolved.candidate.strategy).toBe("ai");
    expect(resolved.candidate.status).toBe("Resolved");
    // A later failure (or a stale row from before re-resolution) leaves the
    // approval gate closed even though the job_sources row still exists.
    await pool.query(
      "UPDATE company_candidates SET status='Failed' WHERE id=$1",
      [candidate.id],
    );
    await expect(
      scanSourceWithDb(
        {
          userId: user.id,
          sourceId: resolved.source!.id,
          connectorOptions: { fetchImpl: aiFetch },
        },
        getDb(),
      ),
    ).rejects.toThrow("must approve this careers source");
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("resolution failures unrelated to robots leave the candidate Failed with the error recorded", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await importCompanies(getDb(), user.id, "Fixture,fixture.example");
    const [{ candidate }] = await listCompanies(getDb(), user.id);
    const result = await runResolveCompanyJob(
      getDb(),
      { data: { userId: user.id, candidateId: candidate.id } },
      {
        fetchImpl: (async () =>
          new Response("Service unavailable", {
            status: 500,
          })) as typeof fetch,
      },
    );
    expect(result).toEqual({ failed: true });
    const [failed] = await listCompanies(getDb(), user.id);
    expect(failed.candidate.status).toBe("Failed");
    expect(failed.candidate.error).toContain("HTTP 500");
    expect(
      (await listActivity(getDb(), user.id)).map((event) => event.stage),
    ).toContain("discovery-failed");
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("two imported organizations with the same name but different domains do not share a watchlist entry", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await importCompanies(
      getDb(),
      user.id,
      "Acme,acme-us.example\nAcme,acme-eu.example",
    );
    expect(result.imported).toBe(2);
    const rows = await listCompanies(getDb(), user.id);
    const us = rows.find((r) => r.candidate.domain === "acme-us.example")!;
    const eu = rows.find((r) => r.candidate.domain === "acme-eu.example")!;
    expect(us.candidate.watchlistId).not.toBeNull();
    // The second candidate's watchlist key collides with the first's; since the
    // existing watchlist entry points at a different domain, it must not be
    // repointed or shared with the second candidate.
    expect(eu.candidate.watchlistId).toBeNull();
    const watchlists = await pool.query(
      "SELECT domain FROM company_watchlists WHERE user_id=$1",
      [user.id],
    );
    expect(watchlists.rows).toEqual([{ domain: "acme-us.example" }]);
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});

test("discovery spend is charged to its own budget, not the evaluation one", async ({
  request,
}) => {
  const user = await register(request);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // A spent evaluation budget must not stop careers extraction, and the
    // reservation must settle against the tokens the provider reports rather
    // than keeping the flat estimate.
    await pool.query(
      `UPDATE career_preferences SET data=jsonb_set(
         jsonb_set(data, '{aiMonthlyBudgetMicros}', '1'),
         '{aiDiscoveryBudgetMicros}', '250000') WHERE user_id=$1`,
      [user.id],
    );
    const extract = discoveryExtractor(
      getDb(),
      user.id,
      { actor: "Worker" },
      {
        apiKey: "fixture-key",
        fetchImpl: (async () =>
          Response.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    jobs: [],
                    nextUrls: [],
                    noOpenings: true,
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 100 },
          })) as typeof fetch,
      },
    );
    await extract({
      url: "https://fixture.example/careers",
      text: "There are no current openings.",
      links: [],
    });
    const [reservation] = (await listActivity(getDb(), user.id)).filter(
      (event) => event.stage === "ai-budget",
    );
    expect(reservation).toBeDefined();
    // Settled from reported usage, so well under the 50,000 reserved.
    expect(reservation.estimatedCostMicros).toBeGreaterThan(0);
    expect(reservation.estimatedCostMicros).toBeLessThan(50_000);
  } finally {
    await cleanup(pool, user.id);
    await pool.end();
  }
});
