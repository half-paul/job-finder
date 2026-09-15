import { describe, expect, it } from "vitest";
import {
  aiEvaluationSchema,
  approximateTokens,
  buildJobText,
  buildTargetText,
  cosineSimilarity,
  createEmbedding,
  createStructuredEvaluation,
  estimateCostMicros,
  evaluationJsonSchema,
  hardFilter,
} from "@jobfinder/matching";
import {
  defaultPreferences,
  demoProfile,
  jobInputSchema,
} from "@jobfinder/shared";

const job = jobInputSchema.parse({
  title: "VP Platform Engineering",
  company: "Example Inc.",
  description:
    "Lead cloud infrastructure, platform engineering and security programs for a growing SaaS company.",
  location: "Vancouver, Canada",
  country: "Canada",
  industry: "SaaS",
  employmentType: "Full-time",
  seniority: "VP",
  workType: "Remote",
  salaryMin: 200000,
  salaryMax: 250000,
  salaryPeriod: "year",
  currency: "CAD",
  jobUrl: "https://example.com/jobs/vp-platform",
  postedAt: null,
});

describe("Phase 3 matching", () => {
  it("computes bounded cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 0])).toThrow();
    expect(() => cosineSimilarity([Number.NaN], [1])).toThrow();
  });

  it("enforces hard preferences before AI evaluation", () => {
    expect(hardFilter(job, defaultPreferences).passed).toBe(true);
    expect(
      hardFilter(job, {
        ...defaultPreferences,
        hardRequirements: {
          ...defaultPreferences.hardRequirements,
          employment: true,
        },
        employmentTypes: ["Contract"],
      }),
    ).toMatchObject({ passed: false });
    const seniorityRequired = {
      ...defaultPreferences,
      hardRequirements: {
        ...defaultPreferences.hardRequirements,
        seniority: true,
      },
      seniority: ["VP" as const],
    };
    // A stated seniority outside the requirement is blocked...
    expect(
      hardFilter({ ...job, seniority: "Director" }, seniorityRequired),
    ).toMatchObject({ passed: false });
    // ...while a missing seniority is evaluated instead of rejected.
    expect(
      hardFilter({ ...job, seniority: "Unknown" }, seniorityRequired),
    ).toMatchObject({ passed: true });
  });

  it("builds deterministic profile and job evidence text", () => {
    const target = buildTargetText(demoProfile, defaultPreferences);
    const listing = buildJobText(job);
    expect(target).toContain("VP Infrastructure");
    expect(listing).toContain("VP Platform Engineering");
    expect(approximateTokens(target, listing)).toBeGreaterThan(0);
  });

  it("uses a strict structured-output JSON Schema", () => {
    expect(evaluationJsonSchema.additionalProperties).toBe(false);
    expect(evaluationJsonSchema.properties.factors.additionalProperties).toBe(
      false,
    );
    expect(evaluationJsonSchema.properties.factors.properties.role).toEqual({
      type: "number",
      minimum: 0,
      maximum: 1,
    });
    expect(Object.keys(evaluationJsonSchema.properties)).toEqual([
      "factors",
      "confidence",
      "reasons",
      "gaps",
      "progression",
    ]);
    expect(
      aiEvaluationSchema.safeParse({
        factors: {
          role: 1.1,
          experience: 1,
          skills: 1,
          leadership: 1,
          industry: 1,
          location: 1,
          compensation: 1,
          direction: 1,
        },
        confidence: "High",
        reasons: ["Strong platform leadership"],
        gaps: [],
        progression: "A natural VP platform step",
      }).success,
    ).toBe(false);
  });

  it("validates OpenAI embeddings and usage without exposing credentials", async () => {
    const vector = Array.from({ length: 1536 }, () => 1);
    let authorization = "";
    const embedding = await createEmbedding("target text", {
      apiKey: "unit-test-key",
      fetchImpl: async (input, init) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(
          JSON.stringify({
            data: [{ embedding: vector }],
            usage: { prompt_tokens: 12 },
          }),
        );
      },
    });
    expect(embedding.embedding).toHaveLength(1536);
    expect(embedding.usage.prompt_tokens).toBe(12);
    expect(authorization).toBe("Bearer unit-test-key");
  });

  it("parses structured evaluations and records token usage", async () => {
    const evaluation = {
      factors: {
        role: 0.9,
        experience: 0.8,
        skills: 0.7,
        leadership: 0.9,
        industry: 0.6,
        location: 0.8,
        compensation: 0.5,
        direction: 0.7,
      },
      confidence: "Medium",
      reasons: ["Platform leadership aligns with your target role"],
      gaps: ["No explicit P&L ownership in the listing"],
      progression: "A credible next platform leadership role",
    };
    const result = await createStructuredEvaluation(
      { job },
      {
        apiKey: "unit-test-key",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify(evaluation),
                    refusal: null,
                  },
                },
              ],
              usage: { prompt_tokens: 1000, completion_tokens: 100 },
            }),
          ),
      },
    );
    expect(result.evaluation).toEqual(evaluation);
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(100);
    expect(
      estimateCostMicros({
        inputTokens: 1000,
        outputTokens: 100,
        embeddingTokens: 1000,
      }),
    ).toBe(1220);
  });

  it.each([
    { content: null, refusal: "Cannot evaluate this input" },
    { content: "not JSON", refusal: null },
    { content: JSON.stringify({ factors: { role: 101 } }), refusal: null },
  ])("rejects unusable evaluations: %j", async (message) => {
    await expect(
      createStructuredEvaluation(
        {},
        {
          apiKey: "unit-test-key",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                choices: [{ message }],
                usage: { prompt_tokens: 10, completion_tokens: 10 },
              }),
            ),
        },
      ),
    ).rejects.toThrow();
  });

  it("rejects wrong embedding dimensions and provider failures", async () => {
    await expect(
      createEmbedding("test", {
        apiKey: "unit-test-key",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: [{ embedding: [1, 2] }],
              usage: { prompt_tokens: 1 },
            }),
          ),
      }),
    ).rejects.toThrow("unexpected embedding size");
    await expect(
      createStructuredEvaluation(
        {},
        {
          apiKey: "unit-test-key",
          fetchImpl: async () => new Response("Unavailable", { status: 503 }),
        },
      ),
    ).rejects.toThrow("OpenAI returned HTTP 503");
  });
});
