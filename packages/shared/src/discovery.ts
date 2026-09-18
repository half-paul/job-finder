import { z } from "zod";

/** Waiting on the worker: neither the board nor Retry should act on these. */
export const isCandidateInFlight = (status: string) =>
  status === "Pending" || status === "Resolving";

/** Page size for the activity feed; the client reads it to offer "load older". */
export const activityPageLimit = 100;

/** Where an imported company sits in the resolution ladder. */
export const candidateStatuses = [
  "Pending",
  "Resolving",
  "Resolved",
  "NoCareersPage",
  "Unsupported",
  "Blocked",
  "Failed",
] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

/** Cheapest first. A cheaper rung discovered later replaces a costlier one. */
export const crawlStrategies = [
  "none",
  "ats",
  "json-ld",
  "captured-api",
  "browser",
  "ai",
] as const;
export type CrawlStrategy = (typeof crawlStrategies)[number];

export const detectableAts = [
  "Greenhouse",
  "Lever",
  "Ashby",
  "Workday",
  "SmartRecruiters",
  "iCIMS",
  "Taleo",
] as const;
export type DetectableAts = (typeof detectableAts)[number];

/** Vendors with a connector today. The rest are recorded as Unsupported. */
export const supportedAts = ["Greenhouse", "Lever", "Ashby"] as const;
export type SupportedAts = (typeof supportedAts)[number];
export const isSupportedAts = (value: string): value is SupportedAts =>
  supportedAts.some((ats) => ats === value);

export const candidateStatusLabel: Record<CandidateStatus, string> = {
  Pending: "Waiting for worker",
  Resolving: "Looking for careers page",
  Resolved: "Resolved",
  NoCareersPage: "No careers page found",
  Unsupported: "Vendor recognised, not yet supported",
  Blocked: "Robots.txt disallows crawling",
  Failed: "Failed",
};

export const strategyLabel: Record<CrawlStrategy, string> = {
  none: "Not resolved",
  ats: "Scanning ATS board",
  "json-ld": "Reading careers page",
  "captured-api": "Replaying saved API",
  browser: "Browser crawl",
  ai: "AI careers extraction",
};

export const companyImportSchema = z.object({
  text: z.string().max(200_000),
});
export type CompanyImport = z.infer<typeof companyImportSchema>;

/** Recorded before any strategy is enabled; shown to the user, never hidden. */
export interface PolicyCheck {
  robotsAllowed: boolean;
  robotsUrl: string;
  checkedAt: string;
  userAgent: string;
  matchedRule?: string;
}
