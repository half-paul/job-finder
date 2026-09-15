import { describe, it, expect } from "vitest";
import {
  defaultPreferences,
  defaultWeights,
  emptyProfile,
  httpUrl,
  preferencesSchema,
  profileSchema,
  sourceInputSchema,
  countries,
  countryCoverage,
  matchesCountries,
  seniorityLevels,
  workTypes,
} from "@jobfinder/shared";
import { aggregateScores } from "@jobfinder/matching";
describe("validated preferences and score aggregation", () => {
  it("accepts stored preferences saved before keyword rules existed", () => {
    const added = new Set([
      "includeKeywords",
      "negativeKeywords",
      "countries",
      "aiMonthlyBudgetMicros",
    ]);
    const legacy = Object.fromEntries(
      Object.entries(defaultPreferences).filter(([key]) => !added.has(key)),
    );
    const parsed = preferencesSchema.parse(legacy);
    expect(parsed.includeKeywords).toEqual([]);
    expect(parsed.negativeKeywords).toEqual([]);
    expect(parsed.countries).toEqual([]);
    expect(parsed.aiMonthlyBudgetMicros).toBe(250_000);
  });
  it("defaults to a five-job automatic evaluation batch", () => {
    const parsed = preferencesSchema.parse(defaultPreferences);
    expect(parsed).toMatchObject({
      countries: [],
      includeWorldwideJobs: true,
      includeUnknownCountryJobs: false,
      autoEvaluateAfterSync: true,
      evaluationBatchSize: 5,
    });
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        evaluationBatchSize: 0,
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        countries: ["XX"],
      }).success,
    ).toBe(false);
    expect(
      countries.some(({ code, name }) => code === "CA" && name === "Canada"),
    ).toBe(true);
  });
  it("offers Unknown for work arrangement and seniority", () => {
    expect(workTypes).toContain("Unknown");
    expect(seniorityLevels).toContain("Unknown");
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        workTypes: ["Remote", "Unknown"],
        seniority: ["VP", "Unknown"],
      }).success,
    ).toBe(true);
  });
  it("matches countries from feed location evidence", () => {
    expect(countryCoverage("CA", "Remote, Canada").codes).toContain("CA");
    expect(countryCoverage("", "London, United Kingdom").codes).toContain("GB");
    expect(countryCoverage("", "Berlin, Germany").codes).toContain("DE");
    expect(countryCoverage("", "United States").codes).toContain("US");
    expect(countryCoverage("", "Remote").codes).toHaveLength(0);
    expect(countryCoverage("", "Anywhere").worldwide).toBe(true);
    expect(countryCoverage("", "Europe").codes).toContain("FR");
    // A bare "Remote" is not worldwide coverage, and an empty selection keeps all jobs.
    expect(
      matchesCountries(
        { country: "", location: "Remote" },
        {
          countries: [],
          includeWorldwideJobs: false,
          includeUnknownCountryJobs: false,
        },
      ),
    ).toBe(true);
    expect(
      matchesCountries(
        { country: "", location: "Remote" },
        {
          countries: ["CA"],
          includeWorldwideJobs: true,
          includeUnknownCountryJobs: false,
        },
      ),
    ).toBe(false);
    expect(
      matchesCountries(
        { country: "", location: "Remote" },
        {
          countries: ["CA"],
          includeWorldwideJobs: false,
          includeUnknownCountryJobs: true,
        },
      ),
    ).toBe(true);
    expect(
      matchesCountries(
        { country: "", location: "Anywhere" },
        {
          countries: ["CA"],
          includeWorldwideJobs: true,
          includeUnknownCountryJobs: false,
        },
      ),
    ).toBe(true);
    expect(
      matchesCountries(
        { country: "US", location: "Austin, TX" },
        {
          countries: ["CA"],
          includeWorldwideJobs: true,
          includeUnknownCountryJobs: true,
        },
      ),
    ).toBe(false);
  });
  it("requires board identifiers only for ATS sources", () => {
    expect(
      sourceInputSchema.safeParse({
        provider: "RemoteOK",
        company: "Remote jobs",
      }).success,
    ).toBe(true);
    expect(
      sourceInputSchema.safeParse({ provider: "Lever", company: "Example" })
        .success,
    ).toBe(false);
    expect(
      sourceInputSchema.safeParse({
        provider: "JSON-LD",
        company: "Example",
        sourceUrl: "https://example.com/careers",
      }).success,
    ).toBe(true);
  });
  it("accepts valid starting records", () => {
    expect(profileSchema.safeParse(emptyProfile).success).toBe(true);
    expect(preferencesSchema.safeParse(defaultPreferences).success).toBe(true);
  });
  it("rejects bad salary ranges and weights", () => {
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        salaryMin: 200000,
        salaryMax: 100000,
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        weights: { ...defaultWeights, role: 99 },
      }).success,
    ).toBe(false);
  });
  it("keeps qualification distinct from interest", () => {
    const result = aggregateScores(
      {
        role: 0,
        experience: 1,
        skills: 1,
        leadership: 1,
        industry: 0,
        location: 0,
        compensation: 0,
        direction: 0,
      },
      defaultWeights,
    );
    expect(result).toEqual({
      overallScore: 50,
      qualificationScore: 100,
      interestScore: 0,
    });
  });
  it("handles unused factor groups without inventing a score", () => {
    expect(
      aggregateScores(
        {
          role: 1,
          experience: 0,
          skills: 0,
          leadership: 0,
          industry: 0,
          location: 0,
          compensation: 0,
          direction: 0,
        },
        {
          role: 100,
          experience: 0,
          skills: 0,
          leadership: 0,
          industry: 0,
          location: 0,
          compensation: 0,
          direction: 0,
        },
      ).qualificationScore,
    ).toBeNull();
    expect(() =>
      aggregateScores(
        {
          role: NaN,
          experience: 0,
          skills: 0,
          leadership: 0,
          industry: 0,
          location: 0,
          compensation: 0,
          direction: 0,
        },
        defaultWeights,
      ),
    ).toThrow();
  });
  it("rejects executable or local-file job links", () => {
    expect(httpUrl.safeParse("javascript:alert(1)").success).toBe(false);
    expect(httpUrl.safeParse("file:///etc/passwd").success).toBe(false);
  });
});
