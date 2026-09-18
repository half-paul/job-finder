import { and, isNotNull, lt, sql } from "drizzle-orm";
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
}

/**
 * Expired sessions and rate-limit buckets are dead rows the request path should
 * never have to sweep. Read notifications are kept for 90 days so the digest
 * and alert history stay inspectable, then removed.
 */
export async function cleanupExpired(
  db: AutomationDb,
  now = new Date(),
  notificationRetentionDays = 90,
): Promise<CleanupResult> {
  const notificationCutoff = new Date(
    now.getTime() - notificationRetentionDays * 86_400_000,
  );
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
  await db
    .delete(activityEvents)
    .where(lt(activityEvents.createdAt, notificationCutoff));
  return {
    sessions: sessionRows.length,
    rateLimits: rateRows.length,
    notifications: notificationRows.length,
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
