import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { defaultPreferences } from "@jobfinder/shared";

const liveSmoke = process.env.DISCOVERY_LIVE_SMOKE === "1";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test.skip(
  !liveSmoke,
  "Set DISCOVERY_LIVE_SMOKE=1 for the external Lever smoke test",
);

test("live sync imports only keyword matches and never re-imports an archived listing", async ({
  request,
}) => {
  const headers = { Origin: "http://localhost:3000" };
  const email = `discovery-keywords-${randomUUID()}@example.test`;
  const registered = await request.post("/api/auth/register", {
    headers,
    data: {
      email,
      password: "Integration-only password 123!",
      name: "Keyword smoke",
    },
  });
  expect(registered.ok()).toBe(true);
  const user = await registered.json();
  const db = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder",
  });
  try {
    const source = await (
      await request.post("/api/sources", {
        headers,
        data: { provider: "Lever", board: "leverdemo", company: "Lever Demo" },
      })
    ).json();
    const setPreferences = (data: Record<string, unknown>) =>
      request.put("/api/preferences", {
        headers,
        data: { ...defaultPreferences, ...data },
      });
    const scan = async () => {
      // Lever ignores conditional requests, but clear the cached validators so
      // the assertion never depends on provider caching behaviour.
      await db.query(
        "UPDATE job_sources SET etag=null, last_modified=null WHERE id=$1",
        [source.id],
      );
      const response = await request.post(`/api/sources/${source.id}`, {
        headers,
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const countJobs = async () =>
      Number(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM jobs WHERE owner_id=$1",
            [user.id],
          )
        ).rows[0].count,
      );

    expect(
      (
        await setPreferences({
          includeKeywords: ["keyword-that-cannot-appear-zzz"],
        })
      ).ok(),
    ).toBe(true);
    const filtered = await scan();
    expect(filtered.status).toBe("Succeeded");
    expect(filtered.discovered).toBeGreaterThan(0);
    expect(filtered.added).toBe(0);
    // A few demo postings have no usable description and are reported as
    // per-listing warnings, so only the normalizable listings are filtered.
    expect(filtered.filtered).toBeGreaterThan(0);
    expect(filtered.filtered).toBeLessThanOrEqual(filtered.discovered);
    expect(
      filtered.warnings.some((warning: string) =>
        warning.includes("skipped by your keyword filters"),
      ),
    ).toBe(true);
    expect(await countJobs()).toBe(0);

    expect((await setPreferences({ includeKeywords: [] })).ok()).toBe(true);
    const imported = await scan();
    expect(imported.added).toBeGreaterThan(0);
    expect(imported.filtered).toBe(0);
    expect(await countJobs()).toBe(imported.added);

    // Excluded keywords block a listing that would otherwise be imported.
    expect(
      (
        await setPreferences({ negativeKeywords: ["a", "e", "the", "and"] })
      ).ok(),
    ).toBe(true);
    const blocked = await scan();
    expect(blocked.added).toBe(0);
    expect(blocked.filtered).toBeGreaterThan(0);

    // Archived listings keep their canonical row, so a later sync re-uses it
    // instead of importing the same posting again.
    expect((await setPreferences({ negativeKeywords: [] })).ok()).toBe(true);
    const [archivedJob] = (
      await db.query(
        `SELECT id, canonical_hash, job_url FROM jobs
         WHERE owner_id=$1 ORDER BY discovered_at DESC LIMIT 1`,
        [user.id],
      )
    ).rows;
    const archive = await request.put(`/api/jobs/${archivedJob.id}/archive`, {
      headers,
      data: { archived: true },
    });
    expect(archive.ok(), await archive.text()).toBe(true);
    const rescanned = await scan();
    expect(rescanned.status).toBe("Succeeded");
    expect(rescanned.added).toBe(0);
    const after = await db.query(
      "SELECT id, archived_at FROM jobs WHERE owner_id=$1 AND canonical_hash=$2",
      [user.id, archivedJob.canonical_hash],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].archived_at).not.toBeNull();
    const listed = await (await request.get("/api/jobs")).json();
    expect(
      listed.items.some(
        (row: { job: { id: string } }) => row.job.id === archivedJob.id,
      ),
    ).toBe(false);
    const archiveView = await (
      await request.get("/api/jobs?view=archived")
    ).json();
    expect(
      archiveView.items.some(
        (row: { job: { id: string } }) => row.job.id === archivedJob.id,
      ),
    ).toBe(true);
  } finally {
    try {
      await db.query("DELETE FROM users WHERE id=$1", [user.id]);
    } finally {
      await db.end();
    }
  }
});

test("Lever demo source imports idempotently and handles changes/removals", async ({
  request,
}) => {
  const headers = { Origin: "http://localhost:3000" };
  const password = "Integration-only password 123!";
  const email = `discovery-live-${randomUUID()}@example.test`;
  const registered = await request.post("/api/auth/register", {
    headers,
    data: { email, password, name: "Discovery smoke" },
  });
  expect(registered.ok()).toBe(true);
  const user = await registered.json();
  const db = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder",
  });
  try {
    const source = await (
      await request.post("/api/sources", {
        headers,
        data: { provider: "Lever", board: "leverdemo", company: "Lever Demo" },
      })
    ).json();

    const first = await (
      await request.post(`/api/sources/${source.id}`, { headers })
    ).json();
    expect(first.status).toBe("Succeeded");
    expect(first.discovered).toBeGreaterThan(0);
    expect(first.added).toBeGreaterThan(0);

    const second = await (
      await request.post(`/api/sources/${source.id}`, { headers })
    ).json();
    expect(second).toMatchObject({
      status: "Succeeded",
      added: 0,
      updated: 0,
      removed: 0,
    });

    const original = await db.query(
      `SELECT j.id, j.description_hash
       FROM jobs j
       JOIN job_references r ON r.job_id = j.id
       WHERE r.source_id = $1
       ORDER BY j.discovered_at DESC
       LIMIT 1`,
      [source.id],
    );
    expect(original.rowCount).toBeGreaterThan(0);
    await db.query(
      "UPDATE jobs SET description = 'Locally changed fixture', description_hash = 'stale-local-hash' WHERE id = $1",
      [original.rows[0].id],
    );
    const changed = await (
      await request.post(`/api/sources/${source.id}`, { headers })
    ).json();
    expect(changed.updated).toBeGreaterThan(0);
    const restored = await db.query(
      "SELECT description_hash FROM jobs WHERE id = $1",
      [original.rows[0].id],
    );
    expect(restored.rows[0].description_hash).toBe(
      original.rows[0].description_hash,
    );

    const fakeUrl = `https://jobs.lever.co/leverdemo/${randomUUID()}`;
    const missing = await db.query(
      `INSERT INTO jobs(
        owner_id,title,company,description,location,country,industry,
        employment_type,seniority,work_type,salary_period,currency,
        job_url,canonical_hash,description_hash,source,lifecycle
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id`,
      [
        user.id,
        "Removed fixture",
        "Lever Demo",
        "A complete scan should mark this fixture removed.",
        "Remote",
        "US",
        "",
        "Full-time",
        "Unknown",
        "Remote",
        "year",
        "Unknown",
        fakeUrl,
        digest(fakeUrl),
        digest("A complete scan should mark this fixture removed."),
        "Lever",
        "Active",
      ],
    );
    await db.query(
      `INSERT INTO job_references(
        job_id,source_id,active,last_seen_at,external_id,url
      ) VALUES ($1,$2,true,now(),$3,$4)`,
      [missing.rows[0].id, source.id, `missing-${randomUUID()}`, fakeUrl],
    );
    const removalRun = await (
      await request.post(`/api/sources/${source.id}`, { headers })
    ).json();
    expect(removalRun.removed).toBeGreaterThan(0);
    const lifecycle = await db.query(
      "SELECT lifecycle FROM jobs WHERE id = $1",
      [missing.rows[0].id],
    );
    expect(lifecycle.rows[0].lifecycle).toBe("Removed");
  } finally {
    try {
      await db.query("DELETE FROM users WHERE id=$1", [user.id]);
    } finally {
      await db.end();
    }
  }
});
