import { z } from "zod";
import { countryCodes } from "./countries";
export * from "./countries";
export * from "./keywords";

const short = z.string().trim().max(200);
const list = z.array(short.min(1)).max(100);
export const employmentTypes = [
  "Full-time",
  "Contract",
  "Fractional",
  "Consulting",
  "Temporary",
  "Permanent",
  "Unknown",
] as const;
export const workTypes = ["Remote", "Hybrid", "On-site", "Unknown"] as const;
export const seniorityLevels = [
  "Manager",
  "Senior Manager",
  "Director",
  "Senior Director",
  "VP",
  "SVP",
  "EVP",
  "C-Level",
  "Founder",
  "Advisor",
  "Consultant",
  "Individual Contributor",
  "Unknown",
] as const;
export const statusValues = [
  "Discovered",
  "Saved",
  "Ignored",
  "Preparing Application",
  "Applied",
  "Interviewing",
  "Rejected",
  "Offer",
  "Withdrawn",
  "Not Interested",
] as const;
export const weightSchema = z
  .object({
    role: z.number().min(0).max(100),
    experience: z.number().min(0).max(100),
    skills: z.number().min(0).max(100),
    leadership: z.number().min(0).max(100),
    industry: z.number().min(0).max(100),
    location: z.number().min(0).max(100),
    compensation: z.number().min(0).max(100),
    direction: z.number().min(0).max(100),
  })
  .refine(
    (v) => Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 100) < 0.001,
    "Score weights must total 100",
  );
export const defaultWeights = {
  role: 20,
  experience: 20,
  skills: 15,
  leadership: 15,
  industry: 10,
  location: 10,
  compensation: 5,
  direction: 5,
};
export const profileSchema = z.object({
  name: short,
  summary: z.string().trim().max(10000),
  currentRole: short,
  previousRoles: list,
  yearsExperience: z.number().int().min(0).max(80),
  location: short,
  skills: list,
  industries: list,
  certifications: list,
  education: list,
  languages: list,
  workAuthorization: list,
  leadershipExperience: z.string().max(5000),
  managementExperience: z.string().max(5000),
  companySizeExperience: list,
  architectureExperience: z.string().max(5000),
});
export type Profile = z.infer<typeof profileSchema>;
export const emptyProfile: Profile = {
  name: "",
  summary: "",
  currentRole: "",
  previousRoles: [],
  yearsExperience: 0,
  location: "",
  skills: [],
  industries: [],
  certifications: [],
  education: [],
  languages: [],
  workAuthorization: [],
  leadershipExperience: "",
  managementExperience: "",
  companySizeExperience: [],
  architectureExperience: "",
};
export const demoProfile: Profile = {
  ...emptyProfile,
  name: "Example technology executive",
  currentRole: "VP Infrastructure",
  yearsExperience: 20,
  location: "Vancouver, Canada",
  summary:
    "Fictional example profile: technology executive focused on cloud transformation, security and responsible AI platforms.",
  skills: [
    "AWS",
    "Cloud architecture",
    "Infrastructure leadership",
    "Cybersecurity",
    "Platform engineering",
    "DevSecOps",
    "PCI DSS",
    "SOC 2",
    "Security governance",
    "AI governance",
    "Generative AI",
    "AI platforms",
    "Responsible AI",
    "Digital transformation",
    "Executive leadership",
  ],
  industries: ["SaaS", "FinTech", "Payments"],
  leadershipExperience: "Technology strategy and cross-functional leadership",
};
export const preferencesSchema = z
  .object({
    targetRoles: z
      .array(
        z.object({
          title: short.min(1),
          group: short,
          weight: z.number().min(1).max(10),
        }),
      )
      .max(100),
    employmentTypes: z.array(z.enum(employmentTypes)).max(7),
    workTypes: z.array(z.enum(workTypes)).max(4),
    includedLocations: list,
    countries: z
      .array(
        z
          .string()
          .refine((code) => countryCodes.has(code), "Choose a valid country"),
      )
      .max(249)
      .default([]),
    includeWorldwideJobs: z.boolean().default(true),
    includeUnknownCountryJobs: z.boolean().default(false),
    autoEvaluateAfterSync: z.boolean().default(true),
    evaluationBatchSize: z.number().int().min(1).max(20).default(5),
    excludedLocations: list,
    excludedCompanies: list,
    preferredCompanies: list,
    seniority: z.array(z.enum(seniorityLevels)).max(13),
    skills: z
      .array(
        z.object({
          name: short.min(1),
          preference: z.enum(["Required", "Preferred", "Neutral", "Excluded"]),
          weight: z.number().min(1).max(10),
        }),
      )
      .max(100),
    industries: list,
    includeKeywords: list.default([]),
    negativeKeywords: list.default([]),
    salaryMin: z.number().nonnegative().max(10000000).nullable(),
    salaryPreferred: z.number().nonnegative().max(10000000).nullable(),
    salaryMax: z.number().nonnegative().max(10000000).nullable(),
    hourlyRate: z.number().nonnegative().max(100000).nullable(),
    currency: z.enum(["CAD", "USD", "EUR", "GBP"]),
    equityPreference: z.enum(["Neutral", "Preferred", "Required"]),
    allowRelocation: z.boolean(),
    onsiteRadiusKm: z.number().min(0).max(1000),
    hardRequirements: z.object({
      location: z.boolean(),
      employment: z.boolean(),
      seniority: z.boolean(),
      salary: z.boolean(),
    }),
    aiMonthlyBudgetMicros: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .default(250_000),
    weights: weightSchema,
  })
  .refine(
    (v) =>
      v.salaryMin === null ||
      v.salaryMax === null ||
      v.salaryMin <= v.salaryMax,
    "Minimum salary must not exceed maximum salary",
  );
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = {
  countries: [],
  includeWorldwideJobs: true,
  includeUnknownCountryJobs: false,
  autoEvaluateAfterSync: true,
  evaluationBatchSize: 5,
  targetRoles: [],
  employmentTypes: ["Full-time", "Contract"],
  workTypes: ["Remote", "Hybrid"],
  includedLocations: [],
  excludedLocations: [],
  excludedCompanies: [],
  preferredCompanies: [],
  seniority: [],
  skills: [],
  industries: [],
  includeKeywords: [],
  negativeKeywords: [],
  salaryMin: null,
  salaryPreferred: null,
  salaryMax: null,
  hourlyRate: null,
  currency: "CAD",
  equityPreference: "Neutral",
  allowRelocation: false,
  onsiteRadiusKm: 50,
  hardRequirements: {
    location: true,
    employment: true,
    seniority: true,
    salary: false,
  },
  aiMonthlyBudgetMicros: 250_000,
  weights: defaultWeights,
};
export const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine(
    (v) => ["https:", "http:"].includes(new URL(v).protocol),
    "Use an HTTP or HTTPS URL",
  );
export const jobInputSchema = z
  .object({
    title: short.min(2),
    company: short.min(1),
    description: z.string().trim().min(20).max(100000),
    location: short,
    country: short,
    industry: short,
    employmentType: z.enum(employmentTypes),
    seniority: z.enum(seniorityLevels),
    workType: z.enum(workTypes),
    salaryMin: z.number().int().nonnegative().max(10000000).nullable(),
    salaryMax: z.number().int().nonnegative().max(10000000).nullable(),
    salaryPeriod: z
      .enum(["year", "hour", "month", "week", "day", "unknown"])
      .default("year"),
    currency: z.enum(["CAD", "USD", "EUR", "GBP", "Unknown"]),
    jobUrl: httpUrl,
    postedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (v) =>
      v.salaryMin === null ||
      v.salaryMax === null ||
      v.salaryMin <= v.salaryMax,
    "Salary range is invalid",
  );
export const authSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(128),
  name: short.optional(),
});
export const actionSchema = z.object({
  status: z.enum(statusValues),
  notes: z.string().max(10000).default(""),
});
export const archiveSchema = z.object({ archived: z.boolean() });
export const matchSchema = z.object({
  qualificationScore: z.number().min(0).max(100),
  interestScore: z.number().min(0).max(100),
  overallScore: z.number().min(0).max(100),
  confidence: z.enum(["Low", "Medium", "High"]),
  reasons: list,
  gaps: list,
  progression: short,
});
export type JobMatch = z.infer<typeof matchSchema>;
const provider = z.enum([
  "Greenhouse",
  "Lever",
  "Ashby",
  "RemoteOK",
  "Jobicy",
  "JSON-LD",
]);
export const sourceInputSchema = z
  .object({
    provider,
    board: short.default(""),
    company: short.default(""),
    sourceUrl: httpUrl.optional(),
  })
  .refine(
    (v) => v.provider !== "JSON-LD" || (Boolean(v.sourceUrl) && v.board === ""),
    "JSON-LD sources require a source URL",
  )
  .refine(
    (v) =>
      v.provider === "JSON-LD" ||
      v.provider === "RemoteOK" ||
      v.provider === "Jobicy" ||
      v.board.length > 0,
    "Board/site name is required",
  );
export type SourceInput = z.infer<typeof sourceInputSchema>;
export const globalSourceProviders = ["RemoteOK", "Jobicy"] as const;
export const isGlobalSource = (provider: string) =>
  globalSourceProviders.some((value) => value === provider);
