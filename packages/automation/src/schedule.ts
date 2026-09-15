import { and, asc, eq, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { automationState, jobSources } from "@jobfinder/db";
import { nextRunAfter, type ScanSchedule } from "@jobfinder/shared";
import type { AutomationDb } from "./scan";

export interface DueSource {
  sourceId: string;
  userId: string;
  schedule: ScanSchedule;
}

/**
 * The next aligned UTC instant for a schedule. Re-exported so the worker and
 * the API compute the same next run from the same shared helper.
 */
export const nextRunFor = (schedule: ScanSchedule, from: Date) =>
  nextRunAfter(schedule, from);

/**
 * Claims up to `limit` enabled sources whose schedule has come due. The claim
 * advances `next_run_at` in the same guarded statement, so two schedulers — or a
 * scheduler restarted mid-tick — cannot enqueue the same slot twice. Missed
 * occurrences while the worker was down collapse into a single run.
 */
export async function claimDueSources(
  db: AutomationDb,
  now = new Date(),
  limit = 25,
): Promise<DueSource[]> {
  const due = await db
    .select({
      sourceId: jobSources.id,
      userId: jobSources.ownerId,
      schedule: jobSources.schedule,
    })
    .from(jobSources)
    .where(
      and(
        eq(jobSources.enabled, true),
        ne(jobSources.schedule, "Manual"),
        isNotNull(jobSources.ownerId),
        or(isNull(jobSources.nextRunAt), lte(jobSources.nextRunAt, now)),
      ),
    )
    .orderBy(asc(jobSources.nextRunAt), asc(jobSources.id))
    .limit(limit);

  const claimed: DueSource[] = [];
  for (const row of due) {
    if (!row.userId) continue;
    const schedule = row.schedule as ScanSchedule;
    const next = nextRunFor(schedule, now);
    const [updated] = await db
      .update(jobSources)
      .set({ nextRunAt: next })
      .where(
        and(
          eq(jobSources.id, row.sourceId),
          or(isNull(jobSources.nextRunAt), lte(jobSources.nextRunAt, now)),
        ),
      )
      .returning({ id: jobSources.id });
    if (updated)
      claimed.push({
        sourceId: row.sourceId,
        userId: row.userId,
        schedule,
      });
  }
  return claimed;
}

/** Records the completed check instant and keeps the next slot aligned. */
export async function markSourceChecked(
  db: AutomationDb,
  input: { sourceId: string; schedule: ScanSchedule; at?: Date },
) {
  const at = input.at ?? new Date();
  await db
    .update(jobSources)
    .set({
      lastCheckedAt: at,
      nextRunAt: nextRunFor(input.schedule, at),
    })
    .where(eq(jobSources.id, input.sourceId));
}

/** Applying a schedule takes effect at the next aligned instant, never now. */
export async function applySchedule(
  db: AutomationDb,
  input: { sourceId: string; schedule: ScanSchedule; from?: Date },
) {
  const from = input.from ?? new Date();
  const [row] = await db
    .update(jobSources)
    .set({
      schedule: input.schedule,
      nextRunAt: nextRunFor(input.schedule, from),
    })
    .where(eq(jobSources.id, input.sourceId))
    .returning();
  return row;
}

export const workerHeartbeatKey = "worker:heartbeat";
export const schedulerHeartbeatKey = "worker:scheduler";

export async function recordWorkerHeartbeat(
  db: AutomationDb,
  value: Record<string, unknown>,
) {
  await recordState(db, workerHeartbeatKey, value);
}

export async function recordState(
  db: AutomationDb,
  key: string,
  value: Record<string, unknown>,
) {
  await db
    .insert(automationState)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: automationState.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function readState(db: AutomationDb, key: string) {
  const [row] = await db
    .select()
    .from(automationState)
    .where(eq(automationState.key, key));
  return row ?? null;
}
