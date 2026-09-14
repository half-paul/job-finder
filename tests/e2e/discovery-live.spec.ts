import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const liveSmoke = Boolean(process.env.DISCOVERY_LIVE_SMOKE);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test.skip(
  !liveSmoke,
  "Set DISCOVERY_LIVE_SMOKE=1 for the external Lever smoke test",
);

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

  const db = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder",
  });
  try {
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
    await db.end();
  }
});
