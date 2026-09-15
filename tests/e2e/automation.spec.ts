import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { defaultPreferences } from "@jobfinder/shared";
import { getDb } from "@jobfinder/db";
import { recordMatchNotifications } from "@jobfinder/automation";
import { runHousekeeping, runScanJob } from "../../apps/worker/src/handlers";

const headers = { Origin: "http://localhost:3000" };
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder";
// The automation services read DATABASE_URL lazily; the Playwright process is
// not the app server, so it needs the same connection string.
process.env.DATABASE_URL ??= databaseUrl;

const db = () => new Pool({ connectionString: databaseUrl });

const register = async (request: APIRequestContext, label: string) => {
  const response = await request.post("/api/auth/register", {
    headers,
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      password: "Integration password 123!",
      name: `Phase 4 ${label}`,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string };
};

const savePreferences = (request: APIRequestContext, data: object) =>
  request.put("/api/preferences", {
    headers,
    data: { ...defaultPreferences, ...data },
  });

const createJob = async (
  request: APIRequestContext,
  data: Record<string, unknown> = {},
) => {
  const response = await request.post("/api/jobs", {
    headers,
    data: {
      title: "Automation fixture role",
      company: "Automation fixture",
      description:
        "A deterministic opportunity created for the Phase 4 automation checks.",
      location: "Remote, Canada",
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
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string };
};

const cleanupUser = async (pool: Pool, userId: string) => {
  await pool.query(
    "DELETE FROM job_references WHERE job_id IN (SELECT id FROM jobs WHERE owner_id=$1)",
    [userId],
  );
  await pool.query("DELETE FROM search_runs WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM company_watchlists WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM job_sources WHERE owner_id=$1", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
};

test("watchlist entries own a directly scanned source and stay user scoped", async ({
  request,
  playwright,
}) => {
  const user = await register(request, "watchlist");
  const pool = db();
  // A second account needs its own cookie jar; reusing `request` would swap the
  // signed-in session and hide an ownership bug.
  const otherContext = await playwright.request.newContext({
    baseURL: "http://localhost:3000",
  });
  try {
    const created = await request.post("/api/watchlist", {
      headers,
      data: {
        company: "Fixture Analytics",
        domain: "fixture-analytics.example",
        provider: "Greenhouse",
        board: "fixture-analytics",
        priority: "High Priority",
        schedule: "Hourly",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const entry = await created.json();
    expect(entry).toMatchObject({
      company: "Fixture Analytics",
      companyKey: "fixture analytics",
      priority: "High Priority",
      provider: "Greenhouse",
    });
    const source = await pool.query<{
      enabled: boolean;
      schedule: string;
      next_run_at: Date;
    }>("SELECT enabled, schedule, next_run_at FROM job_sources WHERE id=$1", [
      entry.sourceId,
    ]);
    expect(source.rows[0].enabled).toBe(true);
    expect(source.rows[0].schedule).toBe("Hourly");
    expect(source.rows[0].next_run_at.getTime()).toBeGreaterThan(Date.now());

    const listed = await (await request.get("/api/watchlist")).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].source.board).toBe("fixture-analytics");

    const duplicate = await request.post("/api/watchlist", {
      headers,
      data: { company: "  fixture   analytics " },
    });
    expect(duplicate.status()).toBe(409);
    expect(
      (
        await request.post("/api/watchlist", {
          headers,
          data: { company: "No board", provider: "Lever" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.post("/api/watchlist", {
          headers,
          data: { company: "Unknown ATS", provider: "Workday" },
        })
      ).status(),
    ).toBe(400);

    const updated = await request.put(`/api/watchlist/${entry.id}`, {
      headers,
      data: { priority: "Dream Company" },
    });
    expect(updated.ok()).toBe(true);
    expect((await updated.json()).priority).toBe("Dream Company");

    const other = await register(otherContext, "watchlist-other");
    expect(
      (
        await otherContext.put(`/api/watchlist/${entry.id}`, {
          headers,
          data: { priority: "Avoid" },
        })
      ).ok(),
    ).toBe(false);
    // A second account sees its own (empty) watchlist only.
    const otherList = await (await otherContext.get("/api/watchlist")).json();
    expect(otherList).toEqual([]);
    await cleanupUser(pool, other.id);

    const removed = await request.delete(`/api/watchlist/${entry.id}`, {
      headers,
    });
    expect(removed.ok()).toBe(true);
    const disabled = await pool.query<{ enabled: boolean; schedule: string }>(
      "SELECT enabled, schedule FROM job_sources WHERE id=$1",
      [entry.sourceId],
    );
    expect(disabled.rows[0]).toMatchObject({
      enabled: false,
      schedule: "Manual",
    });
  } finally {
    await otherContext.dispose();
    await cleanupUser(pool, user.id);
    await pool.end();
  }
});

test("scheduled scans reuse the job id and never duplicate an import", async ({
  request,
}) => {
  const user = await register(request, "worker");
  const pool = db();
  try {
    const created = await request.post("/api/watchlist", {
      headers,
      data: {
        company: "Fixture Robotics",
        provider: "Greenhouse",
        board: "fixture-robotics",
        schedule: "Every 4 hours",
      },
    });
    expect(created.status()).toBe(201);
    const { id, sourceId } = await created.json();
    expect(id).toBeTruthy();

    // A fixture payload stands in for the provider so the scan stays offline.
    const listing = {
      jobs: [
        {
          id: 987654,
          title: "Director of Platform Engineering",
          company_name: "Fixture Robotics",
          content:
            "<p>Own the platform roadmap, reliability and cloud migration.</p>",
          first_published: "2026-09-01T12:00:00Z",
          location: { name: "Remote, Canada" },
          offices: [],
          absolute_url:
            "https://boards.greenhouse.io/fixture-robotics/jobs/987654",
        },
      ],
    };
    const queued: { userId: string; runIds: string[] }[] = [];
    const queue = {
      enqueueEvaluation: async (job: { userId: string; runIds: string[] }) => {
        queued.push(job);
      },
    };
    const jobId = randomUUID();
    const payload = {
      userId: user.id,
      sourceId,
      schedule: "Every 4 hours",
    };
    const options = {
      connectorOptions: {
        fetchImpl: (async () =>
          new Response(JSON.stringify(listing))) as typeof fetch,
      },
    };

    const first = await runScanJob(
      getDb(),
      queue,
      { id: jobId, data: payload },
      options,
    );
    expect(first).toMatchObject({
      runId: jobId,
      status: "Succeeded",
      added: 1,
      failed: null,
      evaluationQueued: true,
    });
    expect(queued).toEqual([{ userId: user.id, runIds: [jobId] }]);

    const runRow = await pool.query<{
      trigger: string;
      duration_ms: number;
      added: number;
      status: string;
    }>(
      "SELECT trigger, duration_ms, added, status FROM search_runs WHERE id=$1",
      [jobId],
    );
    expect(runRow.rows[0].trigger).toBe("Schedule");
    expect(runRow.rows[0].status).toBe("Succeeded");
    expect(runRow.rows[0].duration_ms).toBeGreaterThanOrEqual(0);

    const scheduled = await pool.query<{
      last_checked_at: Date;
      next_run_at: Date;
    }>("SELECT last_checked_at, next_run_at FROM job_sources WHERE id=$1", [
      sourceId,
    ]);
    expect(scheduled.rows[0].last_checked_at).not.toBeNull();
    expect(scheduled.rows[0].next_run_at.getTime()).toBeGreaterThan(Date.now());

    const imported = await pool.query<{ title: string; source: string }>(
      "SELECT title, source FROM jobs WHERE owner_id=$1",
      [user.id],
    );
    expect(imported.rows).toEqual([
      { title: "Director of Platform Engineering", source: "Greenhouse" },
    ]);

    // The same pg-boss job id replays the same run: one run row, one listing.
    const replay = await runScanJob(
      getDb(),
      queue,
      { id: jobId, data: payload },
      options,
    );
    expect(replay.runId).toBe(jobId);
    expect(replay.added).toBe(0);
    const counts = await pool.query<{ runs: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM search_runs WHERE source_id=$1) AS runs,
              (SELECT count(*)::int FROM jobs WHERE owner_id=$2) AS jobs`,
      [sourceId, user.id],
    );
    expect(counts.rows[0]).toEqual({ runs: 1, jobs: 1 });
  } finally {
    await cleanupUser(pool, user.id);
    await pool.end();
  }
});

test("alerts and the daily digest are opt-in, deterministic and idempotent", async ({
  request,
}) => {
  const user = await register(request, "alerts");
  const pool = db();
  try {
    const job = await createJob(request, {
      title: "VP AI Platform",
      company: "Fixture AI",
    });
    const evaluatedAt = new Date();
    await pool.query(
      `INSERT INTO job_matches(user_id, job_id, data, version, estimated_cost_micros, evaluated_at)
       VALUES ($1,$2,$3,'test:v1',1234,$4)`,
      [
        user.id,
        job.id,
        {
          qualificationScore: 95,
          interestScore: 90,
          overallScore: 93,
          confidence: "High",
          reasons: ["Executive platform ownership"],
          gaps: [],
          progression: "Promotion",
        },
        evaluatedAt,
      ],
    );
    expect(
      (
        await savePreferences(request, {
          notificationsEnabled: true,
          notifyMinScore: 90,
          digestEnabled: true,
          digestMinScore: 85,
          digestHourUtc: evaluatedAt.getUTCHours(),
        })
      ).ok(),
    ).toBe(true);

    // Alerts are opt-in and keyed per evaluation, so a replay adds nothing.
    expect(await recordMatchNotifications(user.id, { db: getDb() })).toBe(1);
    expect(await recordMatchNotifications(user.id, { db: getDb() })).toBe(0);

    const alerts = await (await request.get("/api/notifications")).json();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].notification).toMatchObject({
      kind: "Match",
      score: 93,
      readAt: null,
    });
    expect(alerts[0].notification.title).toContain("Excellent Match");
    expect(alerts[0].job.id).toBe(job.id);

    const marked = await request.post("/api/notifications/mark", {
      headers,
      data: { all: true },
    });
    expect(await marked.json()).toEqual({ marked: 1 });
    expect(
      (await (await request.get("/api/notifications")).json())[0].notification
        .readAt,
    ).not.toBeNull();
    expect(
      await (
        await request.post("/api/notifications/mark", {
          headers,
          data: { all: true },
        })
      ).json(),
    ).toEqual({ marked: 0 });
    expect(
      (
        await request.post("/api/notifications/mark", {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(400);

    const digest = await request.post("/api/automation/digest", {
      headers,
      data: { narrative: false },
    });
    expect(digest.ok(), await digest.text()).toBe(true);
    const summary = (await digest.json()).digest;
    expect(summary.newJobs).toBeGreaterThanOrEqual(1);
    expect(summary.counts.highPriority).toBe(1);
    expect(summary.top[0]).toMatchObject({
      jobId: job.id,
      title: "VP AI Platform",
      score: 93,
      band: "Excellent Match",
    });
    expect(summary.narrative).toContain("1 new opportunity");
    // Same UTC hour, same digest: the notification is not duplicated.
    expect(
      (
        await request.post("/api/automation/digest", {
          headers,
          data: { narrative: false },
        })
      ).ok(),
    ).toBe(true);
    const digestRows = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notifications WHERE user_id=$1 AND kind='Digest'",
      [user.id],
    );
    expect(digestRows.rows[0].count).toBe(1);

    const overview = await (await request.get("/api/automation")).json();
    expect(typeof overview.worker.healthy).toBe("boolean");
    expect(overview.unreadNotifications).toBe(1);
  } finally {
    await cleanupUser(pool, user.id);
    await pool.end();
  }
});

test("source schedules are validated and applied on aligned boundaries", async ({
  request,
}) => {
  const user = await register(request, "schedules");
  const pool = db();
  try {
    const added = await request.post("/api/sources", {
      headers,
      data: { provider: "RemoteOK" },
    });
    expect(added.status(), await added.text()).toBe(201);
    const source = await added.json();
    expect(source.schedule).toBe("Manual");
    expect(source.nextRunAt).toBeNull();

    const scheduled = await request.put(`/api/sources/${source.id}/schedule`, {
      headers,
      data: { schedule: "Hourly" },
    });
    expect(scheduled.ok(), await scheduled.text()).toBe(true);
    const body = await scheduled.json();
    const next = new Date(body.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCSeconds()).toBe(0);

    expect(
      (
        await request.put(`/api/sources/${source.id}/schedule`, {
          headers,
          data: { schedule: "Whenever" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.put(`/api/sources/${randomUUID()}/schedule`, {
          headers,
          data: { schedule: "Daily" },
        })
      ).status(),
    ).toBe(404);

    const manual = await request.put(`/api/sources/${source.id}/schedule`, {
      headers,
      data: { schedule: "Manual" },
    });
    expect((await manual.json()).nextRunAt).toBeNull();

    const overview = await (await request.get("/api/automation")).json();
    const diagnostic = overview.sources.find(
      (row: { id: string }) => row.id === source.id,
    );
    expect(diagnostic).toMatchObject({
      provider: "RemoteOK",
      schedule: "Manual",
      enabled: true,
    });
  } finally {
    await cleanupUser(pool, user.id);
    await pool.end();
  }
});

test("housekeeping removes expired sessions and rate-limit buckets", async ({
  request,
}) => {
  const user = await register(request, "cleanup");
  const pool = db();
  try {
    const tokenHash = `expired-${randomUUID()}`;
    const bucket = `expired-${randomUUID()}`;
    await pool.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()-interval '1 day')",
      [tokenHash, user.id],
    );
    await pool.query(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES ($1,3,now()-interval '1 hour')",
      [bucket],
    );
    const result = await runHousekeeping(getDb());
    expect(result.removedSessions).toBeGreaterThanOrEqual(1);
    expect(result.removedRateLimits).toBeGreaterThanOrEqual(1);
    const remaining = await pool.query<{ sessions: number; buckets: number }>(
      `SELECT (SELECT count(*)::int FROM sessions WHERE token_hash=$1) AS sessions,
              (SELECT count(*)::int FROM rate_limits WHERE key=$2) AS buckets`,
      [tokenHash, bucket],
    );
    expect(remaining.rows[0]).toEqual({ sessions: 0, buckets: 0 });
  } finally {
    await cleanupUser(pool, user.id);
    await pool.end();
  }
});
