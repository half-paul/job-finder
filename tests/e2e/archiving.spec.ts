import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const headers = { Origin: "http://localhost:3000" };
const db = () =>
  new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder",
  });
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const createJob = (
  request: APIRequestContext,
  data: Record<string, unknown> = {},
) =>
  request.post("/api/jobs", {
    headers,
    data: {
      title: "Archived fixture role",
      company: "Archive fixture",
      description:
        "A deterministic opportunity used to verify archiving behaviour end to end.",
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

test("archived opportunities leave every count, list and batch without being re-imported", async ({
  page,
}) => {
  const request = page.request;
  const registered = await request.post("/api/auth/register", {
    headers,
    data: {
      email: `archive-${randomUUID()}@example.test`,
      password: "Integration password 123!",
      name: "Archive tester",
    },
  });
  expect(registered.ok(), await registered.text()).toBe(true);
  const user = await registered.json();
  const pool = db();
  try {
    const kept = await (
      await createJob(request, { title: "Kept platform role" })
    ).json();
    const shelved = await (
      await createJob(request, { title: "Shelved platform role" })
    ).json();
    const saved = await request.put(`/api/jobs/${shelved.id}/status`, {
      headers,
      data: { status: "Saved", notes: "Reviewed and set aside." },
    });
    expect(saved.ok(), await saved.text()).toBe(true);

    const stat = (label: string) =>
      page.locator(".stat-card", { hasText: label }).locator("strong");
    await page.goto("/");
    await expect(stat("Opportunities")).toHaveText("2");
    await expect(stat("Saved")).toHaveText("1");

    // A completed global-feed scan references the archived job, so the
    // automatic evaluation batch can be checked without calling the provider.
    const source = await pool.query<{ id: string }>(
      `INSERT INTO job_sources(owner_id, identity, company, provider, board, source_url, enabled)
       VALUES ($1,'fixture:archive','RemoteOK','RemoteOK','remoteok',null,true) RETURNING id`,
      [user.id],
    );
    const run = await pool.query<{ id: string }>(
      "INSERT INTO search_runs(source_id,user_id,status) VALUES ($1,$2,'Succeeded') RETURNING id",
      [source.rows[0].id, user.id],
    );
    await pool.query(
      "INSERT INTO job_references(job_id,source_id,active,external_id,url) VALUES ($1,$2,false,$3,$4)",
      [kept.id, source.rows[0].id, randomUUID(), kept.jobUrl],
    );
    await pool.query(
      "INSERT INTO job_references(job_id,source_id,active,external_id,url) VALUES ($1,$2,true,$3,$4)",
      [shelved.id, source.rows[0].id, randomUUID(), shelved.jobUrl],
    );

    await page
      .getByRole("button", { name: `Archive ${shelved.title}` })
      .click();
    // The success message is transient after the server refresh; the archive
    // state itself is the durable assertion.
    await expect(stat("Opportunities")).toHaveText("1");
    await expect(stat("Saved")).toHaveText("0");
    await expect(
      page.getByRole("link", { name: shelved.title, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: kept.title, exact: true }),
    ).toBeVisible();

    // Hidden from the default list, visible in the archive view and still
    // reachable by id so it can be restored.
    const listed = await (await request.get("/api/jobs")).json();
    expect(
      listed.items.map((row: { job: { id: string } }) => row.job.id),
    ).toEqual([kept.id]);
    const archived = await (
      await request.get("/api/jobs?view=archived")
    ).json();
    expect(
      archived.items.map((row: { job: { id: string } }) => row.job.id),
    ).toEqual([shelved.id]);
    const detail = await request.get(`/api/jobs/${shelved.id}`);
    expect(detail.ok()).toBe(true);
    expect((await detail.json()).job.archivedAt).toBeTruthy();

    // Archived listings are skipped by the automatic evaluation batch.
    const skipped = await request.post("/api/jobs/evaluation-batch", {
      headers,
      data: { runIds: [run.rows[0].id] },
    });
    expect(skipped.ok(), await skipped.text()).toBe(true);
    expect(await skipped.json()).toMatchObject({ selected: 0, evaluated: 0 });

    // The canonical row survives archiving, so the same posting cannot be
    // imported (or added) a second time.
    expect(
      (
        await createJob(request, { title: "Duplicate", jobUrl: shelved.jobUrl })
      ).status(),
    ).toBe(409);
    const duplicates = await pool.query<{ count: string }>(
      "SELECT count(*) FROM jobs WHERE owner_id=$1 AND canonical_hash=$2",
      [user.id, digest(shelved.jobUrl)],
    );
    expect(duplicates.rows[0].count).toBe("1");

    // Restoring puts it back into every count and list, and back into the
    // automatic evaluation batch.
    await page.getByRole("link", { name: "Archived", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Archived opportunities" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `Restore ${shelved.title}` })
      .click();
    await expect(
      page.getByRole("heading", { name: "Nothing archived yet" }),
    ).toBeVisible();
    const restored = await request.post("/api/jobs/evaluation-batch", {
      headers,
      data: { runIds: [run.rows[0].id] },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
    expect((await restored.json()).selected).toBe(1);
    await page.goto("/");
    await expect(stat("Opportunities")).toHaveText("2");
    await expect(stat("Saved")).toHaveText("1");

    // Archiving from the detail page behaves the same way.
    await page.goto(`/jobs/${kept.id}`);
    await page.getByRole("button", { name: "Archive opportunity" }).click();
    await expect(
      page.getByRole("button", { name: "Restore opportunity" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View archived opportunities" }),
    ).toBeVisible();
    expect(
      (await (await request.get("/api/jobs")).json()).items.map(
        (row: { job: { id: string } }) => row.job.id,
      ),
    ).toEqual([shelved.id]);
    await page.getByRole("link", { name: "Archived", exact: true }).click();
    await expect(
      page.getByRole("link", { name: kept.title, exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/archiving-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/archiving-mobile.png",
      fullPage: true,
    });
    const rejectsMissing = await request.put(
      `/api/jobs/${randomUUID()}/archive`,
      { headers, data: { archived: true } },
    );
    expect(rejectsMissing.status()).toBe(404);
  } finally {
    await pool.query("DELETE FROM users WHERE id=$1", [user.id]);
    await pool.end();
  }
});
