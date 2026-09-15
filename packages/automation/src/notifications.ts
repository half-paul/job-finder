import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { jobMatches, jobs, notifications, preferences } from "@jobfinder/db";
import {
  AppError,
  defaultPreferences,
  markNotificationsSchema,
  matchBand,
  preferencesSchema,
} from "@jobfinder/shared";
import type { AutomationDb } from "./scan";

/**
 * One alert per evaluation, never one per worker pass. A job that is
 * re-evaluated to a new score is genuinely new information for the user, and the
 * instant in the key makes replays of the same evaluation a no-op.
 */
export const matchNotificationKey = (
  jobId: string,
  evaluatedAt: Date,
  score: number,
) => `match:${jobId}:${score}:${evaluatedAt.getTime()}`;

export const digestNotificationKey = (at: Date) => {
  const day = at.toISOString().slice(0, 10);
  return `digest:${day}:${at.getUTCHours()}`;
};

export interface NotificationDraft {
  userId: string;
  jobId: string | null;
  kind: "Match" | "Digest" | "System";
  title: string;
  body: string;
  score: number | null;
  dedupeKey: string;
}

/** Inserts drafts idempotently; returns how many rows were actually created. */
export async function insertNotifications(
  db: AutomationDb,
  drafts: NotificationDraft[],
) {
  if (!drafts.length) return 0;
  const rows = await db
    .insert(notifications)
    .values(drafts)
    .onConflictDoNothing({
      target: [notifications.userId, notifications.dedupeKey],
    })
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * Alerts for scores at or above the user's threshold. Runs after manual and
 * scheduled evaluations, is opt-in, and is deterministic: the model's wording
 * never decides whether an alert exists.
 */
export async function recordMatchNotifications(
  userId: string,
  options: { db: AutomationDb; limit?: number },
) {
  const { db } = options;
  const [row] = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId));
  const settings = preferencesSchema.parse(row?.data ?? defaultPreferences);
  if (!settings.notificationsEnabled) return 0;
  const candidates = await db
    .select({
      jobId: jobMatches.jobId,
      score: sql<number>`(${jobMatches.data}->>'overallScore')::int`,
      evaluatedAt: jobMatches.evaluatedAt,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      bandData: jobMatches.data,
    })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .where(
      and(
        eq(jobMatches.userId, userId),
        isNull(jobs.archivedAt),
        sql`(${jobMatches.data}->>'overallScore')::numeric >= ${settings.notifyMinScore}`,
      ),
    )
    .orderBy(desc(jobMatches.evaluatedAt))
    .limit(options.limit ?? 200);

  const drafts = candidates.map((candidate) => {
    const band = matchBand(candidate.score);
    const reason = candidate.bandData.reasons[0];
    return {
      userId,
      jobId: candidate.jobId,
      kind: "Match" as const,
      title: `${band}: ${candidate.title}`,
      body: [
        `${candidate.company}${candidate.location ? ` · ${candidate.location}` : ""} scored ${candidate.score}/100.`,
        reason,
      ]
        .filter(Boolean)
        .join(" "),
      score: candidate.score,
      dedupeKey: matchNotificationKey(
        candidate.jobId,
        candidate.evaluatedAt,
        candidate.score,
      ),
    };
  });
  return insertNotifications(db, drafts);
}

export async function listNotifications(
  db: AutomationDb,
  userId: string,
  limit = 100,
) {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  return db
    .select({
      notification: notifications,
      job: {
        id: jobs.id,
        title: jobs.title,
        company: jobs.company,
        lifecycle: jobs.lifecycle,
      },
    })
    .from(notifications)
    .leftJoin(jobs, eq(jobs.id, notifications.jobId))
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(safeLimit);
}

export async function unreadNotificationCount(
  db: AutomationDb,
  userId: string,
) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row.count;
}

export async function markNotifications(
  db: AutomationDb,
  userId: string,
  body: unknown,
) {
  const input = markNotificationsSchema.parse(body);
  if (!input.all && !input.id)
    throw new AppError(400, "Choose a notification or mark all as read.");
  const scope = input.id ? inArray(notifications.id, [input.id]) : sql`true`;
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        scope,
      ),
    )
    .returning({ id: notifications.id });
  return { marked: rows.length };
}
