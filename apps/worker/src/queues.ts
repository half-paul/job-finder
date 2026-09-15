import { z } from "zod";

/**
 * Queue names are part of the contract between the web app, the scheduler and
 * the handlers, so they live in one place.
 */
export const queueNames = {
  scanSource: "scan-source",
  scheduleSources: "schedule-sources",
  evaluateBatch: "evaluate-batch",
  housekeeping: "housekeeping",
} as const;

export const scanSourceJobSchema = z.object({
  userId: z.uuid(),
  sourceId: z.uuid(),
  schedule: z.string(),
});
export type ScanSourceJob = z.infer<typeof scanSourceJobSchema>;

export const evaluateBatchJobSchema = z.object({
  userId: z.uuid(),
  runIds: z.array(z.uuid()).min(1).max(1000),
});
export type EvaluateBatchJob = z.infer<typeof evaluateBatchJobSchema>;

export const housekeepingJobSchema = z.object({
  /** ISO instant the pass was scheduled for; keeps retries deterministic. */
  requestedAt: z.iso.datetime().optional(),
});
export type HousekeepingJob = z.infer<typeof housekeepingJobSchema>;

export const scheduleTickJobSchema = z.object({
  requestedAt: z.iso.datetime().optional(),
});
export type ScheduleTickJob = z.infer<typeof scheduleTickJobSchema>;

/**
 * One active job per source. A queued or running scan blocks a second enqueue
 * for the same board, which is what keeps the scheduler tick idempotent.
 */
export const scanSingletonKey = (userId: string, sourceId: string) =>
  `scan:${userId}:${sourceId}`;

export const evaluationSingletonKey = (userId: string) => `evaluate:${userId}`;
