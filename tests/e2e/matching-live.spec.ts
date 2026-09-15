import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const liveSmoke = process.env.AI_LIVE_SMOKE === "1";
test.skip(!liveSmoke, "Set AI_LIVE_SMOKE=1 for the paid OpenAI smoke test");

test("AI matching persists structured scores, embeddings and usage", async ({
  page,
}) => {
  test.setTimeout(120000);
  const request = page.request;
  const headers = { Origin: "http://localhost:3000" };
  const password = "Integration-only password 123!";
  const email = `ai-live-${randomUUID()}@example.test`;
  const registered = await request.post("/api/auth/register", {
    headers,
    data: { email, password, name: "AI smoke tester" },
  });
  expect(registered.ok()).toBe(true);
  const user = await registered.json();
  const db = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jobfinder:local-development-only@localhost:54329/jobfinder",
  });
  try {
    expect(
      (
        await request.put("/api/profile", {
          headers,
          data: {
            name: "AI smoke tester",
            summary:
              "Technology executive focused on cloud transformation, security and responsible AI platforms.",
            currentRole: "VP Infrastructure",
            previousRoles: [],
            yearsExperience: 20,
            location: "Vancouver, Canada",
            skills: [
              "AWS",
              "Cloud architecture",
              "Infrastructure leadership",
              "Cybersecurity",
            ],
            industries: ["SaaS", "FinTech"],
            certifications: [],
            education: [],
            languages: [],
            workAuthorization: [],
            leadershipExperience:
              "Technology strategy and cross-functional leadership",
            managementExperience: "Managed engineering leaders",
            companySizeExperience: [],
            architectureExperience: "Designed cloud platform architecture",
          },
        })
      ).ok(),
    ).toBe(true);
    const job = await (
      await request.post("/api/jobs", {
        headers,
        data: {
          title: "VP Platform Engineering",
          company: "Example AI Inc.",
          description:
            "Lead cloud infrastructure, platform engineering and security programs for a growing SaaS company. Own architecture, engineering leadership and operational reliability.",
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
    const evaluationResponse = await request.post(
      `/api/jobs/${job.id}/evaluate`,
      {
        headers,
      },
    );
    const evaluationText = await evaluationResponse.text();
    expect(evaluationResponse.ok(), evaluationText).toBe(true);
    const evaluation = JSON.parse(evaluationText);
    expect(evaluation.match).toMatchObject({
      confidence: expect.any(String),
      overallScore: expect.any(Number),
      qualificationScore: expect.any(Number),
      interestScore: expect.any(Number),
    });
    expect(evaluation.match.overallScore).toBeGreaterThanOrEqual(0);
    expect(evaluation.match.overallScore).toBeLessThanOrEqual(100);
    expect(evaluation.usage.inputTokens).toBeGreaterThan(0);
    expect(evaluation.usage.outputTokens).toBeGreaterThan(0);
    expect(evaluation.usage.embeddingTokens).toBeGreaterThan(0);
    expect(evaluation.usage.estimatedCostMicros).toBeGreaterThan(0);
    expect(evaluation.usage.semanticSimilarity).toBeGreaterThanOrEqual(-1);
    expect(evaluation.usage.semanticSimilarity).toBeLessThanOrEqual(1);

    const match = await db.query(
      "SELECT data, input_tokens, output_tokens, embedding_tokens, estimated_cost_micros FROM job_matches WHERE user_id=$1 AND job_id=$2",
      [user.id, job.id],
    );
    expect(match.rowCount).toBe(1);
    expect(match.rows[0].input_tokens).toBeGreaterThan(0);
    const embeddings = await db.query(
      `SELECT
         (SELECT count(*) FROM target_embeddings WHERE user_id=$1)::int AS target_count,
         (SELECT count(*) FROM job_embeddings WHERE job_id=$2)::int AS job_count`,
      [user.id, job.id],
    );
    expect(embeddings.rows[0]).toMatchObject({ target_count: 1, job_count: 1 });
    await page.goto(`/jobs/${job.id}`);
    await expect(
      page.getByRole("button", { name: "Re-evaluate match" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/matching-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/matching-mobile.png",
      fullPage: true,
    });
    const repeatedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/jobs/${job.id}/evaluate`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Re-evaluate match" }).click();
    const repeated = await repeatedResponse;
    expect(repeated.ok(), await repeated.text()).toBe(true);
    const cachedEvaluation = await repeated.json();
    expect(cachedEvaluation.usage.embeddingTokens).toBe(0);
    await expect(page.getByRole("status")).toHaveText("Evaluation complete.");
    console.log(
      JSON.stringify({
        firstEvaluation: evaluation.usage,
        cachedEvaluation: cachedEvaluation.usage,
      }),
    );
    const profile = await (await request.get("/api/profile")).json();
    expect(
      (await request.put("/api/profile", { headers, data: profile })).ok(),
    ).toBe(true);
    expect(
      (
        await db.query("SELECT 1 FROM target_embeddings WHERE user_id=$1", [
          user.id,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    try {
      await db.query("DELETE FROM users WHERE id=$1", [user.id]);
    } finally {
      await db.end();
    }
  }
});
