import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { defaultPreferences } from "@jobfinder/shared";

const headers = { Origin: "http://localhost:3000" };
const db = () =>
  new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder",
  });

const createJob = (
  request: APIRequestContext,
  data: Record<string, unknown> = {},
) =>
  request.post("/api/jobs", {
    headers,
    data: {
      title: "Synced platform role",
      company: "Sync fixture",
      description:
        "A deterministic opportunity created during the simulated source sync.",
      location: "Remote",
      country: "Canada",
      industry: "Software",
      employmentType: "Full-time",
      seniority: "Director",
      workType: "Remote",
      salaryMin: null,
      salaryMax: null,
      salaryPeriod: "year",
      currency: "CAD",
      jobUrl: `https://example.test/jobs/${randomUUID()}`,
      postedAt: null,
      ...data,
    },
  });

test("portal syncs every global feed, skips legacy sources and evaluates the batch", async ({
  page,
}) => {
  const registered = await page.request.post("/api/auth/register", {
    headers,
    data: {
      email: `sync-${randomUUID()}@example.test`,
      password: "Integration password 123!",
      name: "Sync tester",
    },
  });
  expect(registered.status()).toBe(200);
  const user = await registered.json();
  const pool = db();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Sync jobs", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "No enabled global feeds",
    );
    await page
      .getByRole("link", { name: "Manage sources and view scan results" })
      .click();
    // A global feed needs no company or board name.
    await expect(page.getByLabel("Company")).toHaveCount(0);
    await expect(page.getByLabel("Board / site name")).toHaveCount(0);
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await expect(
      page.getByRole("row").filter({ hasText: "RemoteOK" }),
    ).toBeVisible();
    const inserted = await pool.query<{ id: string; provider: string }>(
      `INSERT INTO job_sources(owner_id, identity, company, provider, board, source_url, enabled)
       VALUES ($1,'fixture:jobicy','Jobicy','Jobicy','jobicy',null,true),
              ($1,'fixture:legacy','Legacy board','Ashby','legacy',null,true)
       RETURNING id, provider`,
      [user.id],
    );
    const jobicy = inserted.rows.find((row) => row.provider === "Jobicy")!;
    const remote = (await (await page.request.get("/api/sources")).json()).find(
      (row: { source: { provider: string } }) =>
        row.source.provider === "RemoteOK",
    ).source;
    const calls: string[] = [];
    const runId = randomUUID();
    let releaseJobicy!: () => void;
    const jobicyHeld = new Promise<void>((resolve) => {
      releaseJobicy = resolve;
    });
    await page.route(/\/api\/sources\/[\w-]+$/, async (route) => {
      const id = route.request().url().split("/").pop()!;
      calls.push(id);
      if (id === jobicy.id) {
        await jobicyHeld;
        await route.fulfill({
          status: 502,
          json: { error: "Fixture provider unavailable" },
        });
        return;
      }
      const imported = await createJob(page.request);
      expect(imported.status(), await imported.text()).toBe(201);
      await route.fulfill({
        json: {
          id: runId,
          status: "Succeeded",
          added: 2,
          updated: 1,
          removed: 0,
          warnings: [],
          error: null,
        },
      });
    });
    const evaluated: { runIds: string[] }[] = [];
    await page.route("**/api/jobs/evaluation-batch", async (route) => {
      evaluated.push(route.request().postDataJSON() as { runIds: string[] });
      await route.fulfill({
        json: {
          enabled: true,
          limit: 5,
          selected: 3,
          evaluated: 3,
          blocked: 0,
          failed: 0,
          errors: [],
        },
      });
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Not a global feed", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Sync jobs", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "Syncing Jobicy (1 of 2)",
    );
    await expect(
      page.getByRole("button", { name: "Syncing…", exact: true }),
    ).toBeDisabled();
    // Progress survives client-side workspace navigation.
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "Syncing Jobicy (1 of 2)",
    );
    releaseJobicy();
    await expect(page.getByRole("status")).toContainText(
      "Sync finished: 1 succeeded, 0 partial, 1 failed. 2 added · 1 changed · 0 removed.",
    );
    await expect(page.getByRole("status")).toContainText(
      "Evaluation: 3 evaluated, 0 failed (maximum 5 per sync).",
    );
    expect(calls).toEqual([jobicy.id, remote.id]);
    expect(evaluated).toEqual([{ runIds: [runId] }]);
    await expect(
      page.getByRole("link", { name: "Synced platform role", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Discovery", exact: true }).click();
    await expect(page.getByText("Indeed is not connected")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/job-sync-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: "Sync jobs", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/job-sync-mobile.png",
      fullPage: true,
    });
  } finally {
    await pool.query(
      "DELETE FROM job_references WHERE job_id IN (SELECT id FROM jobs WHERE owner_id=$1)",
      [user.id],
    );
    await pool.query("DELETE FROM search_runs WHERE user_id=$1", [user.id]);
    await pool.query("DELETE FROM job_sources WHERE owner_id=$1", [user.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [user.id]);
    await pool.end();
  }
});

test("country preferences hide and exclude out-of-scope jobs from evaluation", async ({
  request,
}) => {
  const created = await request.post("/api/auth/register", {
    headers,
    data: {
      email: `country-${randomUUID()}@example.test`,
      password: "Integration password 123!",
      name: "Country tester",
    },
  });
  expect(created.ok()).toBe(true);
  const user = await created.json();
  const pool = db();
  const client = await pool.connect();
  try {
    const canadian = await (
      await createJob(request, {
        country: "Canada",
        location: "Toronto, Canada",
      })
    ).json();
    const american = await (
      await createJob(request, {
        country: "US",
        location: "Austin, Texas",
      })
    ).json();
    // A completed global-feed scan references the US job only, so the country
    // pre-filter is exercised without calling the AI provider.
    const source = await pool.query<{ id: string }>(
      `INSERT INTO job_sources(owner_id, identity, company, provider, board, source_url, enabled)
       VALUES ($1,'fixture:country','RemoteOK','RemoteOK','remoteok',null,true) RETURNING id`,
      [user.id],
    );
    const run = await pool.query<{ id: string }>(
      "INSERT INTO search_runs(source_id,user_id,status) VALUES ($1,$2,'Succeeded') RETURNING id",
      [source.rows[0].id, user.id],
    );
    await pool.query(
      "INSERT INTO job_references(job_id,source_id,active,external_id,url) VALUES ($1,$2,true,'us-1',$3)",
      [american.id, source.rows[0].id, american.jobUrl],
    );
    const update = (data: Record<string, unknown>) =>
      request.put("/api/preferences", {
        headers,
        data: { ...defaultPreferences, ...data },
      });
    expect(
      (await update({ countries: ["CA"], includeWorldwideJobs: false })).ok(),
    ).toBe(true);
    const scoped = await (await request.get("/api/jobs")).json();
    expect(
      scoped.items.map((row: { job: { id: string } }) => row.job.id),
    ).toEqual([canadian.id]);
    const batch = await request.post("/api/jobs/evaluation-batch", {
      headers,
      data: { runIds: [run.rows[0].id] },
    });
    expect(batch.ok(), await batch.text()).toBe(true);
    expect(await batch.json()).toMatchObject({
      enabled: true,
      limit: 5,
      selected: 0,
      evaluated: 0,
    });
    expect((await update({ countries: [] })).ok()).toBe(true);
    const all = await (await request.get("/api/jobs")).json();
    expect(
      all.items.map((row: { job: { id: string } }) => row.job.id).sort(),
    ).toEqual([canadian.id, american.id].sort());
    // The preference also caps the batch and can disable automatic evaluation.
    expect((await update({ evaluationBatchSize: 1 })).ok()).toBe(true);
    const capped = await (
      await request.post("/api/jobs/evaluation-batch", {
        headers,
        data: { runIds: [run.rows[0].id] },
      })
    ).json();
    expect(capped.limit).toBe(1);
    expect((await update({ autoEvaluateAfterSync: false })).ok()).toBe(true);
    const disabled = await (
      await request.post("/api/jobs/evaluation-batch", {
        headers,
        data: { runIds: [run.rows[0].id] },
      })
    ).json();
    expect(disabled).toMatchObject({
      enabled: false,
      selected: 0,
      evaluated: 0,
    });
    const foreign = await request.post("/api/jobs/evaluation-batch", {
      headers,
      data: { runIds: [randomUUID()] },
    });
    expect(foreign.status()).toBe(400);
    expect((await foreign.json()).error).toContain(
      "belonging to your workspace",
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock_all()");
    await client.query(
      "DELETE FROM job_references WHERE job_id IN (SELECT id FROM jobs WHERE owner_id=$1)",
      [user.id],
    );
    await client.query("DELETE FROM search_runs WHERE user_id=$1", [user.id]);
    await client.query("DELETE FROM job_sources WHERE owner_id=$1", [user.id]);
    await client.query("DELETE FROM users WHERE id=$1", [user.id]);
    client.release();
    await pool.end();
  }
});

test("source API reports latest failures, rejects overlap and scopes ownership", async ({
  request,
}) => {
  const created = await request.post("/api/auth/register", {
    headers,
    data: {
      email: `sync-api-${randomUUID()}@example.test`,
      password: "Integration password 123!",
      name: "Sync API",
    },
  });
  expect(created.ok()).toBe(true);
  const user = await created.json();
  const pool = db();
  const client = await pool.connect();
  try {
    // Global feeds are identified by provider alone.
    const added = await request.post("/api/sources", {
      headers,
      data: { provider: "RemoteOK" },
    });
    expect(added.status()).toBe(201);
    const source = await added.json();
    expect(
      (
        await request.post("/api/sources", {
          headers,
          data: {
            provider: "RemoteOK",
            company: "Same feed",
            board: "anything",
          },
        })
      ).status(),
    ).toBe(409);
    const jobicy = await request.post("/api/sources", {
      headers,
      data: { provider: "Jobicy" },
    });
    expect(jobicy.status()).toBe(201);
    await client.query(
      "INSERT INTO search_runs(source_id,user_id,status,created_at) VALUES ($1,$2,'Succeeded',now()-interval '1 hour'), ($1,$2,'Failed',now())",
      [source.id, user.id],
    );
    const rows = await (await request.get("/api/sources")).json();
    expect(
      rows.find(
        (row: { source: { id: string } }) => row.source.id === source.id,
      ).lastRun.status,
    ).toBe("Failed");
    await client.query(
      "SELECT pg_advisory_lock(hashtext('jobfinder:discovery'),hashtext($1))",
      [user.id],
    );
    const overlap = await request.post(`/api/sources/${source.id}`, {
      headers,
    });
    expect(overlap.status()).toBe(409);
    expect((await overlap.json()).error).toContain("already running");
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('jobfinder:discovery'),hashtext($1))",
      [user.id],
    );
    await client.query("UPDATE job_sources SET enabled=false WHERE id=$1", [
      source.id,
    ]);
    expect(
      (await request.post(`/api/sources/${source.id}`, { headers })).status(),
    ).toBe(409);
    // A nonexistent/foreign source is rejected before any connector request.
    expect(
      (
        await request.post(`/api/sources/${randomUUID()}`, { headers })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.post(`/api/sources/${source.id}`, {
          headers: { Origin: "https://other.example" },
        })
      ).status(),
    ).toBe(403);
    await request.post("/api/auth/logout", { headers });
    expect(
      (await request.post(`/api/sources/${source.id}`, { headers })).status(),
    ).toBe(401);
  } finally {
    await client.query("SELECT pg_advisory_unlock_all()");
    await client.query("DELETE FROM search_runs WHERE user_id=$1", [user.id]);
    await client.query("DELETE FROM job_sources WHERE owner_id=$1", [user.id]);
    await client.query("DELETE FROM users WHERE id=$1", [user.id]);
    client.release();
    await pool.end();
  }
});
