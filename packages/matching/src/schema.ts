import { z } from "zod";

export const evaluationFactorKeys = [
  "role",
  "experience",
  "skills",
  "leadership",
  "industry",
  "location",
  "compensation",
  "direction",
] as const;
export type EvaluationFactors = Record<
  (typeof evaluationFactorKeys)[number],
  number
>;

export const aiEvaluationSchema = z.object({
  factors: z.object({
    role: z.number().min(0).max(1),
    experience: z.number().min(0).max(1),
    skills: z.number().min(0).max(1),
    leadership: z.number().min(0).max(1),
    industry: z.number().min(0).max(1),
    location: z.number().min(0).max(1),
    compensation: z.number().min(0).max(1),
    direction: z.number().min(0).max(1),
  }),
  confidence: z.enum(["Low", "Medium", "High"]),
  reasons: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  gaps: z.array(z.string().trim().min(1).max(200)).max(8),
  progression: z.string().trim().min(1).max(300),
});

export type AiEvaluation = z.infer<typeof aiEvaluationSchema>;

export const evaluationJsonSchema = {
  type: "object",
  properties: {
    factors: {
      type: "object",
      properties: {
        role: { type: "number", minimum: 0, maximum: 1 },
        experience: { type: "number", minimum: 0, maximum: 1 },
        skills: { type: "number", minimum: 0, maximum: 1 },
        leadership: { type: "number", minimum: 0, maximum: 1 },
        industry: { type: "number", minimum: 0, maximum: 1 },
        location: { type: "number", minimum: 0, maximum: 1 },
        compensation: { type: "number", minimum: 0, maximum: 1 },
        direction: { type: "number", minimum: 0, maximum: 1 },
      },
      required: [...evaluationFactorKeys],
      additionalProperties: false,
    },
    confidence: { type: "string", enum: ["Low", "Medium", "High"] },
    reasons: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
      minItems: 1,
      maxItems: 8,
    },
    gaps: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
      maxItems: 8,
    },
    progression: { type: "string", minLength: 1, maxLength: 300 },
  },
  required: ["factors", "confidence", "reasons", "gaps", "progression"],
  additionalProperties: false,
} as const;
