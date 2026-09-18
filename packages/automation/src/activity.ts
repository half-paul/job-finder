import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { activityEvents } from "@jobfinder/db";
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

export async function listActivity(
  db: AutomationDb,
  userId: string,
  options: { before?: Date; candidateId?: string } = {},
) {
  return db
    .select()
    .from(activityEvents)
    .where(
      and(
        or(eq(activityEvents.userId, userId), isNull(activityEvents.userId)),
        options.before
          ? lt(activityEvents.createdAt, options.before)
          : undefined,
        options.candidateId
          ? eq(activityEvents.candidateId, options.candidateId)
          : undefined,
      ),
    )
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(100);
}
