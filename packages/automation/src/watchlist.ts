import { and, asc, eq } from "drizzle-orm";
import {
  companyCandidates,
  companyWatchlists,
  jobSources,
} from "@jobfinder/db";
import {
  AppError,
  watchlistInputSchema,
  watchlistKey,
  watchlistUpdateSchema,
  type WatchlistInput,
} from "@jobfinder/shared";
import { applySchedule, nextRunFor } from "./schedule";
import { sourceIdentity, type AutomationDb } from "./scan";

/**
 * Watchlist entries are the user's own priority list. An entry that names a
 * supported ATS board also owns the employer source the worker scans, so the
 * company is checked directly even when it never appears on a public feed.
 */
export async function listWatchlist(db: AutomationDb, userId: string) {
  const rows = await db
    .select({
      entry: companyWatchlists,
      source: jobSources,
    })
    .from(companyWatchlists)
    .leftJoin(jobSources, eq(jobSources.id, companyWatchlists.sourceId))
    .where(eq(companyWatchlists.userId, userId))
    .orderBy(asc(companyWatchlists.company));
  return rows.map(({ entry, source }) => ({
    ...entry,
    source: source ?? null,
  }));
}

export async function createWatchlist(
  db: AutomationDb,
  userId: string,
  body: unknown,
) {
  const input = watchlistInputSchema.parse(body);
  const key = watchlistKey(input.company);
  const [existing] = await db
    .select({ id: companyWatchlists.id })
    .from(companyWatchlists)
    .where(
      and(
        eq(companyWatchlists.userId, userId),
        eq(companyWatchlists.companyKey, key),
      ),
    );
  if (existing)
    throw new AppError(409, "That company is already on your watchlist.");
  const sourceId = await ensureWatchlistSource(db, userId, input);
  const [entry] = await db
    .insert(companyWatchlists)
    .values({
      userId,
      company: input.company,
      companyKey: key,
      domain: input.domain,
      provider: input.provider,
      board: input.board,
      priority: input.priority,
      notes: input.notes,
      sourceId,
    })
    .returning();
  return entry;
}

export async function updateWatchlist(
  db: AutomationDb,
  userId: string,
  id: string,
  body: unknown,
) {
  const input = watchlistUpdateSchema.parse(body);
  const [existing] = await db
    .select()
    .from(companyWatchlists)
    .where(
      and(eq(companyWatchlists.id, id), eq(companyWatchlists.userId, userId)),
    );
  if (!existing) throw new AppError(404, "Watchlist entry not found.");
  const merged: WatchlistInput = watchlistInputSchema.parse({
    company: input.company ?? existing.company,
    domain: input.domain ?? existing.domain,
    provider: input.provider === undefined ? existing.provider : input.provider,
    board: input.board ?? existing.board,
    priority: input.priority ?? existing.priority,
    notes: input.notes ?? existing.notes,
    schedule: input.schedule,
  });
  const companyKey = watchlistKey(merged.company);
  const sourceId = await ensureWatchlistSource(db, userId, merged, {
    previousSourceId: existing.sourceId,
  });
  const [entry] = await db
    .update(companyWatchlists)
    .set({
      company: merged.company,
      companyKey,
      domain: merged.domain,
      provider: merged.provider,
      board: merged.board,
      priority: merged.priority,
      notes: merged.notes,
      sourceId,
      updatedAt: new Date(),
    })
    .where(eq(companyWatchlists.id, id))
    .returning();
  return entry;
}

export async function deleteWatchlist(
  db: AutomationDb,
  userId: string,
  id: string,
) {
  // One transaction: a failure part way through must not leave candidates
  // deleted while the entry they belong to is still listed.
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companyWatchlists)
      .where(
        and(eq(companyWatchlists.id, id), eq(companyWatchlists.userId, userId)),
      );
    if (!existing) throw new AppError(404, "Watchlist entry not found.");
    await tx
      .delete(companyCandidates)
      .where(
        and(
          eq(companyCandidates.watchlistId, id),
          eq(companyCandidates.userId, userId),
        ),
      );
    await tx.delete(companyWatchlists).where(eq(companyWatchlists.id, id));
    // Disable rather than delete: imported provenance stays intact and the
    // scheduled scan stops without removing the user's listings.
    if (existing.sourceId)
      await tx
        .update(jobSources)
        .set({ enabled: false, schedule: "Manual", nextRunAt: null })
        .where(
          and(
            eq(jobSources.id, existing.sourceId),
            eq(jobSources.ownerId, userId),
          ),
        );
    return { id };
  });
}

export async function ensureWatchlistSource(
  db: AutomationDb,
  userId: string,
  input: WatchlistInput,
  options: { previousSourceId?: string | null } = {},
) {
  if (input.provider && !input.board)
    throw new AppError(
      400,
      "A board name is required to scan an employer directly.",
    );
  if (!input.provider) return options.previousSourceId ?? null;
  const identity = sourceIdentity({
    provider: input.provider,
    board: input.board,
  });
  const [created] = await db
    .insert(jobSources)
    .values({
      ownerId: userId,
      identity,
      company: input.company,
      provider: input.provider,
      board: input.board,
      enabled: true,
      schedule: input.schedule,
      nextRunAt: nextRunFor(input.schedule, new Date()),
    })
    .onConflictDoNothing({
      target: [jobSources.ownerId, jobSources.identity],
    })
    .returning();
  if (created) return created.id;
  const [existing] = await db
    .select()
    .from(jobSources)
    .where(
      and(eq(jobSources.ownerId, userId), eq(jobSources.identity, identity)),
    );
  if (!existing) return options.previousSourceId ?? null;
  await db
    .update(jobSources)
    .set({ enabled: true, company: input.company })
    .where(eq(jobSources.id, existing.id));
  await applySchedule(db, { sourceId: existing.id, schedule: input.schedule });
  return existing.id;
}
