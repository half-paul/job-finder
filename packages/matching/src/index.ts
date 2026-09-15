import {
  jobInputSchema,
  preferencesSchema,
  profileSchema,
  weightSchema,
  matchesCountries,
} from "@jobfinder/shared";
import type { z } from "zod";
export * from "./schema";
export * from "./openai";
export type Weights = z.infer<typeof weightSchema>;
export type JobInput = z.infer<typeof jobInputSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type PreferencesInput = z.infer<typeof preferencesSchema>;
/** Aggregation only; factors must come from evidence-based evaluation in Phase 3. */
export function aggregateScores(factors: Weights, inputWeights: Weights) {
  const weights = weightSchema.parse(inputWeights);
  const keys = Object.keys(weights) as (keyof Weights)[];
  for (const key of keys)
    if (!Number.isFinite(factors[key]) || factors[key] < 0 || factors[key] > 1)
      throw new Error("Factors must be between 0 and 1");
  const score = (subset: (keyof Weights)[]) => {
    const total = subset.reduce((n, k) => n + weights[k], 0);
    return total === 0
      ? null
      : Math.round(
          (subset.reduce((n, k) => n + factors[k] * weights[k], 0) / total) *
            100,
        );
  };
  return {
    overallScore: score(keys)!,
    qualificationScore: score(["experience", "skills", "leadership"]),
    interestScore: score([
      "role",
      "industry",
      "location",
      "compensation",
      "direction",
    ]),
  };
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0)
    throw new Error("Embeddings must have matching non-zero dimensions");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i]))
      throw new Error("Embeddings must contain finite values");
    dot += left[i] * right[i];
    leftNorm += left[i] ** 2;
    rightNorm += right[i] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0)
    throw new Error("Embeddings must not be zero vectors");
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function includesAny(haystack: string, needles: string[]) {
  const values = needles
    .map((needle) => needle.trim().toLowerCase())
    .filter(Boolean);
  return values.some((needle) => haystack.toLowerCase().includes(needle));
}

export type HardFilterResult =
  { passed: true } | { passed: false; reason: string };

/**
 * A posting that omits a value is evaluated rather than rejected for that
 * field. Stated values must still meet the hard requirement.
 */
export const isMissingValue = (value: string) => value === "Unknown";

export function hardFilter(
  job: JobInput,
  preferences: PreferencesInput,
): HardFilterResult {
  if (!matchesCountries(job, preferences))
    return {
      passed: false,
      reason: "The job is outside your selected countries.",
    };
  const hard = preferences.hardRequirements;
  if (hard.location && preferences.includedLocations.length > 0) {
    const locationText = [job.location, job.country, job.workType].join(" ");
    const remoteAllowed =
      preferences.workTypes.includes("Remote") && job.workType === "Remote";
    if (
      !remoteAllowed &&
      !includesAny(locationText, preferences.includedLocations)
    )
      return {
        passed: false,
        reason: "The location does not meet your hard location requirement.",
      };
  }
  if (
    hard.employment &&
    preferences.employmentTypes.length > 0 &&
    !preferences.employmentTypes.includes(job.employmentType)
  )
    return {
      passed: false,
      reason: "The employment type does not meet your hard requirement.",
    };
  if (
    hard.seniority &&
    preferences.seniority.length > 0 &&
    !isMissingValue(job.seniority) &&
    !preferences.seniority.includes(job.seniority)
  )
    return {
      passed: false,
      reason: "The seniority does not meet your hard requirement.",
    };
  if (hard.salary && preferences.salaryMin !== null) {
    const comparable =
      job.salaryPeriod === "year" &&
      job.currency === preferences.currency &&
      job.salaryMin !== null;
    if (!comparable || job.salaryMin! < preferences.salaryMin)
      return {
        passed: false,
        reason:
          "Comparable compensation is missing or below your hard minimum.",
      };
  }
  return { passed: true };
}

export function buildTargetText(
  profile: ProfileInput,
  preferences: PreferencesInput,
) {
  return [
    `Target roles: ${preferences.targetRoles.map((role) => `${role.title} (${role.group || role.weight}/10)`).join("; ") || "Not specified"}`,
    `Current role: ${profile.currentRole || "Not specified"}`,
    `Years of experience: ${profile.yearsExperience}`,
    `Skills: ${profile.skills.join(", ") || "Not specified"}`,
    `Industries: ${profile.industries.join(", ") || "Not specified"}`,
    `Leadership: ${profile.leadershipExperience || "Not specified"}`,
    `Management: ${profile.managementExperience || "Not specified"}`,
    `Preferred work arrangement: ${preferences.workTypes.join(", ") || "Not specified"}`,
    `Preferred seniority: ${preferences.seniority.join(", ") || "Not specified"}`,
    `Preferred locations: ${preferences.includedLocations.join(", ") || "Open"}`,
    `Selected countries: ${preferences.countries.join(", ") || "All"}`,
    `Preferred industries: ${preferences.industries.join(", ") || "Open"}`,
    `Required skills: ${
      preferences.skills
        .filter((skill) => skill.preference === "Required")
        .map((skill) => skill.name)
        .join(", ") || "None"
    }`,
    `Missing listing values: when a listing does not state work arrangement or seniority, infer it from the description. Do not treat a missing value as a mismatch by itself.`,
    `Summary: ${profile.summary || "Not specified"}`,
  ].join("\n");
}

export function buildJobText(job: JobInput) {
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location || "Unknown"}`,
    `Work: ${job.workType}${isMissingValue(job.workType) ? " (not stated)" : ""}`,
    `Employment: ${job.employmentType}`,
    `Seniority: ${job.seniority}${isMissingValue(job.seniority) ? " (not stated)" : ""}`,
    `Industry: ${job.industry || "Unknown"}`,
    `Description: ${job.description}`,
  ].join("\n");
}

export function estimateCostMicros(usage: {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
}) {
  return Math.ceil(
    usage.inputTokens * 0.75 +
      usage.outputTokens * 4.5 +
      usage.embeddingTokens * 0.02,
  );
}

export function approximateTokens(...values: string[]) {
  return Math.ceil(values.join("\n").length / 4);
}
