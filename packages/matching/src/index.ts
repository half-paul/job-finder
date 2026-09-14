import { weightSchema } from "@jobfinder/shared";
import type { z } from "zod";
export type Weights = z.infer<typeof weightSchema>;
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
