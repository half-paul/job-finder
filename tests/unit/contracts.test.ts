import { describe, it, expect } from "vitest";
import {
  defaultPreferences,
  defaultWeights,
  emptyProfile,
  httpUrl,
  preferencesSchema,
  profileSchema,
} from "@jobfinder/shared";
import { aggregateScores } from "@jobfinder/matching";
describe("validated preferences and score aggregation", () => {
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
