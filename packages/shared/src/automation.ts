import { z } from "zod";

const short = z.string().trim().max(200);

/** ATS providers whose board identity can be resolved from a watchlist entry. */
export const atsProviders = ["Greenhouse", "Lever", "Ashby"] as const;
export type AtsProvider = (typeof atsProviders)[number];

/**
 * How often the worker refreshes a source. `Manual` never runs on a schedule,
 * so nothing is scanned until the user asks. Schedules are applied on UTC hour
 * boundaries so a restart cannot pile up duplicate refreshes.
 */
export const scanSchedules = [
  "Manual",
  "Hourly",
  "Every 4 hours",
  "Twice daily",
  "Daily",
] as const;
export type ScanSchedule = (typeof scanSchedules)[number];

const scheduleHours: Record<ScanSchedule, number | null> = {
  Manual: null,
  Hourly: 1,
  "Every 4 hours": 4,
  "Twice daily": 12,
  Daily: 24,
};

/**
 * The next aligned UTC instant strictly after `from`, or null for a manual
 * schedule. Alignment keeps the interval stable across restarts.
 */
export function nextRunAfter(schedule: ScanSchedule, from: Date): Date | null {
  const every = scheduleHours[schedule];
  if (every === null) return null;
  const span = every * 3_600_000;
  return new Date(Math.floor(from.getTime() / span) * span + span);
}

export const runStatusValues = [
  "Queued",
  "Running",
  "Succeeded",
  "Partial",
  "Failed",
] as const;
export type RunStatus = (typeof runStatusValues)[number];

export const terminalRunStatuses = ["Succeeded", "Partial", "Failed"] as const;

export const watchlistPriorities = [
  "Dream Company",
  "High Priority",
  "Interesting",
  "Neutral",
  "Avoid",
] as const;
export type WatchlistPriority = (typeof watchlistPriorities)[number];

export const watchlistInputSchema = z.object({
  company: short.min(1),
  domain: short.default(""),
  provider: z.enum(atsProviders).nullable().default(null),
  board: short.default(""),
  priority: z.enum(watchlistPriorities).default("Interesting"),
  notes: z.string().trim().max(2000).default(""),
  /** How often a directly-scanned employer board is refreshed. */
  schedule: z.enum(scanSchedules).default("Every 4 hours"),
});
export type WatchlistInput = z.infer<typeof watchlistInputSchema>;

export const watchlistUpdateSchema = watchlistInputSchema.partial();
export type WatchlistUpdate = z.infer<typeof watchlistUpdateSchema>;

export const notificationKinds = ["Match", "Digest", "System"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const markNotificationsSchema = z.object({
  id: z.uuid().optional(),
  all: z.boolean().default(false),
});

export const digestRequestSchema = z.object({
  /** Ask the model for prose only when the user explicitly requests it. */
  narrative: z.boolean().default(false),
});

/**
 * Notification and digest thresholds live with the other user preferences so
 * stored JSON written before Phase 4 keeps parsing with conservative defaults.
 * Nothing is sent until the user opts in; alerts are in-app records first.
 */
export const automationPreferenceShape = {
  notificationsEnabled: z.boolean().default(true),
  notifyMinScore: z.number().int().min(0).max(100).default(90),
  digestEnabled: z.boolean().default(false),
  digestMinScore: z.number().int().min(0).max(100).default(85),
  /** UTC hour (0–23) the daily digest is generated when it is enabled. */
  digestHourUtc: z.number().int().min(0).max(23).default(13),
};

export const sourceScheduleSchema = z.object({
  schedule: z.enum(scanSchedules),
});
export type SourceScheduleInput = z.infer<typeof sourceScheduleSchema>;

/**
 * Recommendation bands are deterministic so alerts, digests and the UI agree.
 * They describe the aggregate score, never the model's wording.
 */
export const matchBands = [
  { label: "Excellent Match", min: 90 },
  { label: "Strong Match", min: 80 },
  { label: "Possible Match", min: 65 },
  { label: "Stretch Opportunity", min: 50 },
  { label: "Weak Match", min: 1 },
  { label: "Do Not Apply", min: 0 },
] as const;
export type MatchBand = (typeof matchBands)[number]["label"];

export function matchBand(score: number): MatchBand {
  return matchBands.find((band) => score >= band.min)?.label ?? "Do Not Apply";
}

/** Normalized company key so watchlist entries cannot be duplicated by casing. */
export const watchlistKey = (company: string) =>
  company.trim().toLowerCase().replace(/\s+/g, " ");
