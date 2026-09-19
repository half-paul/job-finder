import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  activityEvents,
  notifications,
  rateLimits,
  sessions,
} from "@jobfinder/db";
import type { AutomationDb } from "./scan";

export interface CleanupResult {
  sessions: number;
  rateLimits: number;
  notifications: number;
  activity: number;
}

/** Activity is a high-volume operational log, not history worth a quarter. */
export const activityRetentionDays = 14;

/**
 * Expired sessions and rate-limit buckets are dead rows the request path should
 * never have to sweep. Read notifications are kept for 90 days so the digest
 * and alert history stay inspectable, then removed. Activity events churn far
 * faster than notifications, so they get their own, much shorter window and
 * are deleted in bounded batches rather than one unbounded statement.
 */
export async function cleanupExpired(
  db: AutomationDb,
  now = new Date(),
  notificationRetentionDays = 90,
  activityDays = activityRetentionDays,
): Promise<CleanupResult> {
  const notificationCutoff = new Date(
    now.getTime() - notificationRetentionDays * 86_400_000,
  );
  const activityCutoff = new Date(now.getTime() - activityDays * 86_400_000);
  const sessionRows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ tokenHash: sessions.tokenHash });
  const rateRows = await db
    .delete(rateLimits)
    .where(lt(rateLimits.expiresAt, now))
    .returning({ key: rateLimits.key });
  const notificationRows = await db
    .delete(notifications)
    .where(
      and(
        isNotNull(notifications.readAt),
        lt(notifications.createdAt, notificationCutoff),
      ),
    )
    .returning({ id: notifications.id });
  let activity = 0;
  // Bounded batches keep one housekeeping tick from holding a long delete
  // over the largest table in the database.
  for (;;) {
    const removed = await db
      .delete(activityEvents)
      .where(
        inArray(
          activityEvents.id,
          db
            .select({ id: activityEvents.id })
            .from(activityEvents)
            .where(lt(activityEvents.createdAt, activityCutoff))
            .limit(5000),
        ),
      )
      .returning({ id: activityEvents.id });
    activity += removed.length;
    if (removed.length < 5000) break;
  }
  return {
    sessions: sessionRows.length,
    rateLimits: rateRows.length,
    notifications: notificationRows.length,
    activity,
  };
}

/** Aggregate backlog counters for the diagnostics view; no PII. */
export async function cleanupBacklog(db: AutomationDb, now = new Date()) {
  const [row] = await db
    .select({ expiredSessions: sql<number>`count(*)::int` })
    .from(sessions)
    .where(lt(sessions.expiresAt, now));
  return row;
}
