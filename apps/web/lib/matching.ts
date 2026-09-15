import "server-only";
import {
  evaluateJob as evaluateJobRecord,
  evaluateSyncedJobs as evaluateSyncedJobsRecord,
  recordMatchNotifications,
} from "@jobfinder/automation";
import { getDb } from "@jobfinder/db";

/**
 * Evaluation services live in `@jobfinder/automation` so the worker can run the
 * same bounded batch after a scheduled scan. The web layer only re-exports them
 * behind the server-only boundary.
 */
export const evaluateJob = evaluateJobRecord;
export const evaluateSyncedJobs = evaluateSyncedJobsRecord;

/** Alerts are opt-in, deterministic and cheap, so they follow an evaluation inline. */
export async function alertOnMatches(userId: string) {
  return recordMatchNotifications(userId, { db: getDb() });
}
