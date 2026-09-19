import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { activityEvents } from "@jobfinder/db";
import { activityPageLimit } from "@jobfinder/shared";
import type { AutomationDb } from "./scan";

export type ActivityInput = Omit<
  typeof activityEvents.$inferInsert,
  "id" | "createdAt"
>;
export async function recordActivity(db: AutomationDb, input: ActivityInput) {
  await recordActivities(db, [input]);
}

/** One insert for a batch of events: bulk paths must not write row by row. */
export async function recordActivities(
  db: AutomationDb,
  inputs: ActivityInput[],
) {
  if (!inputs.length) return;
  await db.insert(activityEvents).values(
    inputs.map((input) => ({
      ...input,
      message: input.message.slice(0, 1000),
    })),
  );
}

/**
 * Pages by the full sort key. A createdAt-only cursor dropped every row that
 * shared the boundary timestamp, and a batch insert gives hundreds of rows the
 * same one, so "load older" silently skipped them. The cursor is a row id and
 * the boundary is read back from that row, which also avoids truncating the
 * column's microseconds down to a millisecond ISO string on the way out.
 */
export async function listActivity(
  db: AutomationDb,
  userId: string,
  options: { beforeId?: string; candidateId?: string } = {},
) {
  const visible = or(
    eq(activityEvents.userId, userId),
    isNull(activityEvents.userId),
  );
  // The comparison stays in SQL on purpose. created_at is a microsecond
  // timestamptz and any round trip through a JS Date truncates it to
  // milliseconds, which silently drops rows between the two values. A
  // row-wise compare against the cursor row matches the ORDER BY exactly.
  const beforeCursor = options.beforeId
    ? sql`(${activityEvents.createdAt}, ${activityEvents.id}) < (select ${activityEvents.createdAt}, ${activityEvents.id} from ${activityEvents} where ${activityEvents.id} = ${options.beforeId})`
    : undefined;
  return db
    .select()
    .from(activityEvents)
    .where(
      and(
        visible,
        beforeCursor,
        options.candidateId
          ? eq(activityEvents.candidateId, options.candidateId)
          : undefined,
      ),
    )
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(activityPageLimit);
}
