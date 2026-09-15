import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { defaultPreferences } from "@jobfinder/shared";
const headers = { Origin: "http://localhost:3000" };
const password = "Integration-only password 123!";
test("API validates input, enforces ownership, and revokes persisted sessions", async ({
  request,
}) => {
  const email = `api-${randomUUID()}@example.test`;
  const created = await request.post("/api/auth/register", {
    headers,
    data: { email, password, name: "API tester" },
  });
  expect(created.ok()).toBe(true);
  const user = await created.json();
  expect((await request.get("/api/profile")).ok()).toBe(true);
  expect(
    (
      await request.put("/api/preferences", {
        headers,
        data: { weights: { role: 200 } },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/resumes", {
        headers,
        multipart: {
          file: {
            name: "resume.exe",
            mimeType: "application/octet-stream",
            buffer: Buffer.from("An executable is not a valid resume."),
          },
        },
      })
    ).status(),
  ).toBe(415);
  const db = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder",
  });
  try {
    const records = await db.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [user.id],
    );
    expect(records.rows[0].password_hash).not.toContain(password);
    expect(records.rows[0].password_hash).toMatch(/^scrypt-v1:/);
    const session = await db.query(
      "SELECT token_hash FROM sessions WHERE user_id = $1",
      [user.id],
    );
    expect(session.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    const state = await request.storageState();
    const token = state.cookies.find((c) => c.name === "jobfinder_session");
    expect(token?.httpOnly).toBe(true);
    expect(token?.sameSite).toBe("Lax");
    expect(session.rows[0].token_hash).not.toBe(token?.value);
    expect((await request.post("/api/auth/logout", { headers })).ok()).toBe(
      true,
    );
    expect(
      (
        await db.query("SELECT token_hash FROM sessions WHERE user_id = $1", [
          user.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await request.get("/api/profile")).status()).toBe(401);
    await expect(
      db.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now())",
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (
        await db.query(
          "SELECT extname FROM pg_extension WHERE extname='vector'",
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await db.end();
  }
});
test("login attempts use a shared database-backed limit", async ({
  request,
}) => {
  const email = `limit-${randomUUID()}@example.test`;
  for (let i = 0; i < 10; i++)
    expect(
      (
        await request.post("/api/auth/login", {
          headers,
          data: { email, password },
        })
      ).status(),
    ).toBe(401);
  expect(
    (
      await request.post("/api/auth/login", {
        headers,
        data: { email, password },
      })
    ).status(),
  ).toBe(429);
});

test("source management validates allowlists and keeps sources user-scoped", async ({
  request,
}) => {
  const headers = { Origin: "http://localhost:3000" };
  const email = `sources-${randomUUID()}@example.test`;
  const otherEmail = `other-sources-${randomUUID()}@example.test`;
  const password = "Integration-only password 123!";
  expect(
    (
      await request.post("/api/auth/register", {
        headers,
        data: { email, password, name: "Source tester" },
      })
    ).ok(),
  ).toBe(true);
  const source = await request.post("/api/sources", {
    headers,
    data: { provider: "Greenhouse", board: "example", company: "Example Inc." },
  });
  expect(source.status()).toBe(201);
  expect(
    (
      await request.post("/api/sources", {
        headers,
        data: {
          provider: "Greenhouse",
          board: "example",
          company: "Example Inc.",
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.post("/api/sources", {
        headers,
        data: {
          provider: "JSON-LD",
          board: "",
          company: "Example Inc.",
          sourceUrl: "https://not-allowlisted.example/careers",
        },
      })
    ).status(),
  ).toBe(400);
  const sources = await (await request.get("/api/sources")).json();
  expect(sources).toHaveLength(1);
  expect(sources[0].source).toMatchObject({
    provider: "Greenhouse",
    board: "example",
    company: "Example Inc.",
  });
  expect(
    (
      await request.post("/api/auth/register", {
        headers,
        data: { email: otherEmail, password, name: "Other source tester" },
      })
    ).ok(),
  ).toBe(true);
  const otherSources = await (
    await request.get("/api/sources", { headers })
  ).json();
  expect(otherSources).toHaveLength(0);
});

test("hard preferences block AI evaluation before an API request", async ({
  request,
}) => {
  const headers = { Origin: "http://localhost:3000" };
  const email = `matching-${randomUUID()}@example.test`;
  const password = "Integration-only password 123!";
  expect(
    (
      await request.post("/api/auth/register", {
        headers,
        data: { email, password, name: "Matching tester" },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.put("/api/profile", {
        headers,
        data: {
          name: "Matching tester",
          summary:
            "Technology executive with cloud infrastructure and security leadership experience.",
          currentRole: "VP Infrastructure",
          previousRoles: [],
          yearsExperience: 20,
          location: "Vancouver, Canada",
          skills: ["AWS", "Cloud architecture", "Security governance"],
          industries: ["SaaS"],
          certifications: [],
          education: [],
          languages: [],
          workAuthorization: [],
          leadershipExperience: "Led platform and security organizations",
          managementExperience: "Managed engineering leaders",
          companySizeExperience: [],
          architectureExperience: "Designed cloud platform architecture",
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.put("/api/preferences", {
        headers,
        data: {
          ...defaultPreferences,
          employmentTypes: ["Contract"],
          hardRequirements: {
            location: false,
            employment: true,
            seniority: false,
            salary: false,
          },
        },
      })
    ).ok(),
  ).toBe(true);
  const job = await (
    await request.post("/api/jobs", {
      headers,
      data: {
        title: "VP Platform Engineering",
        company: "Example Matching Inc.",
        description:
          "Lead cloud infrastructure, platform engineering and security programs for a growing SaaS company.",
        location: "Vancouver, Canada",
        country: "Canada",
        industry: "SaaS",
        employmentType: "Full-time",
        seniority: "VP",
        workType: "Remote",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "year",
        currency: "CAD",
        jobUrl: `https://example.test/careers/${randomUUID()}`,
        postedAt: null,
      },
    })
  ).json();
  const evaluation = await (
    await request.post(`/api/jobs/${job.id}/evaluate`, { headers })
  ).json();
  expect(evaluation.match).toBeNull();
  expect(evaluation.blocked.passed).toBe(false);
  expect(evaluation.blocked.reason).toContain("employment type");
  expect(
    (
      await request.put("/api/preferences", {
        headers,
        data: { ...defaultPreferences, aiMonthlyBudgetMicros: 0 },
      })
    ).ok(),
  ).toBe(true);
  const overBudget = await request.post(`/api/jobs/${job.id}/evaluate`, {
    headers,
  });
  expect(overBudget.status()).toBe(429);
  expect((await overBudget.json()).error).toContain("monthly AI budget");
  const detail = await (await request.get(`/api/jobs/${job.id}`)).json();
  expect(detail.match).toBeNull();
});
