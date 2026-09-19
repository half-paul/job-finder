import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  companyCandidates,
  companyWatchlists,
  jobSources,
  searchRuns,
} from "@jobfinder/db";
import { parseSeedList } from "@jobfinder/discovery";
import { AppError, watchlistKey } from "@jobfinder/shared";
import type { AutomationDb } from "./scan";
import { recordActivities, recordActivity } from "./activity";

export async function importCompanies(
  db: AutomationDb,
  userId: string,
  text: string,
) {
  const parsed = parseSeedList(text);
  if (!parsed.rows.length)
    return { imported: 0, duplicates: 0, rejected: parsed.rejected };
  // One transaction with set-based writes: an import of the 500-row limit
  // costs a handful of round trips rather than one transaction per row.
  return db.transaction(async (tx) => {
    const candidates = await tx
      .insert(companyCandidates)
      .values(
        parsed.rows.map((row) => ({
          userId,
          name: row.name,
          domain: row.domain,
          websiteUrl: row.websiteUrl ?? `https://${row.domain}/`,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: companyCandidates.id,
        name: companyCandidates.name,
        domain: companyCandidates.domain,
      });
    const imported = candidates.length;
    const duplicates = parsed.rows.length - imported;
    if (!imported) return { imported, duplicates, rejected: parsed.rejected };

    const keyed = candidates.map((candidate) => ({
      ...candidate,
      key: watchlistKey(candidate.name),
    }));
    await tx
      .insert(companyWatchlists)
      .values(
        keyed.map((candidate) => ({
          userId,
          company: candidate.name,
          companyKey: candidate.key,
          domain: candidate.domain,
        })),
      )
      .onConflictDoNothing();
    const watchlists = await tx
      .select({
        id: companyWatchlists.id,
        companyKey: companyWatchlists.companyKey,
        domain: companyWatchlists.domain,
      })
      .from(companyWatchlists)
      .where(
        and(
          eq(companyWatchlists.userId, userId),
          inArray(
            companyWatchlists.companyKey,
            keyed.map((candidate) => candidate.key),
          ),
        ),
      );
    const watchlistByKey = new Map(
      watchlists.map((entry) => [entry.companyKey, entry]),
    );

    const links: { candidateId: string; watchlistId: string }[] = [];
    const backfill: { watchlistId: string; domain: string }[] = [];
    for (const candidate of keyed) {
      const entry = watchlistByKey.get(candidate.key);
      // Distinct domains can have the same display name; do not repoint an unrelated watchlist.
      if (!entry || (entry.domain && entry.domain !== candidate.domain))
        continue;
      if (!entry.domain)
        backfill.push({ watchlistId: entry.id, domain: candidate.domain });
      links.push({ candidateId: candidate.id, watchlistId: entry.id });
    }
    if (backfill.length)
      await tx.execute(sql`
        update company_watchlists as w set domain = v.domain
        from (values ${sql.join(
          backfill.map(
            (row) => sql`(${row.watchlistId}::uuid, ${row.domain}::text)`,
          ),
          sql`, `,
        )}) as v(id, domain)
        where w.id = v.id
      `);
    if (links.length)
      await tx.execute(sql`
        update company_candidates as c set watchlist_id = v.watchlist_id
        from (values ${sql.join(
          links.map(
            (row) => sql`(${row.candidateId}::uuid, ${row.watchlistId}::uuid)`,
          ),
          sql`, `,
        )}) as v(candidate_id, watchlist_id)
        where c.id = v.candidate_id
      `);

    await recordActivities(
      tx,
      candidates.map((candidate) => ({
        userId,
        candidateId: candidate.id,
        actor: "Application",
        stage: "queued",
        message: `${candidate.name}: queued for website and careers discovery.`,
      })),
    );
    return { imported, duplicates, rejected: parsed.rejected };
  });
}

/** One import can add 500 rows, so the board reads a bounded page of them. */
export const companyPageLimit = 500;
export async function listCompanies(
  db: AutomationDb,
  userId: string,
  options: { limit?: number } = {},
) {
  const limit = Math.min(
    Math.max(options.limit ?? companyPageLimit, 1),
    companyPageLimit,
  );
  const rows = await db
    .select({ candidate: companyCandidates, source: jobSources })
    .from(companyCandidates)
    .leftJoin(jobSources, eq(jobSources.id, companyCandidates.sourceId))
    .where(eq(companyCandidates.userId, userId))
    .orderBy(asc(companyCandidates.name))
    .limit(limit);
  const runs = await db
    .select()
    .from(searchRuns)
    .where(eq(searchRuns.userId, userId))
    .orderBy(desc(searchRuns.startedAt))
    .limit(500);
  const latestRunBySource = new Map<string, (typeof runs)[number]>();
  for (const run of runs)
    if (run.sourceId && !latestRunBySource.has(run.sourceId))
      latestRunBySource.set(run.sourceId, run);
  return rows.map((row) => ({
    ...row,
    lastRun: (row.source && latestRunBySource.get(row.source.id)) ?? null,
  }));
}

export async function retryCompany(
  db: AutomationDb,
  userId: string,
  id: string,
) {
  const [row] = await db
    .update(companyCandidates)
    .set({ status: "Pending", error: "", updatedAt: new Date() })
    .where(
      and(
        eq(companyCandidates.id, id),
        eq(companyCandidates.userId, userId),
        inArray(companyCandidates.status, [
          "Resolved",
          "Failed",
          "Blocked",
          "Unsupported",
          "NoCareersPage",
        ]),
      ),
    )
    .returning();
  if (!row)
    throw new AppError(
      409,
      "Company is unavailable or already waiting for the worker.",
    );
  await recordActivity(db, {
    userId,
    candidateId: id,
    actor: "Application",
    stage: "queued",
    message: `${row.name}: discovery requested again.`,
  });
  return row;
}

export async function deleteCompany(
  db: AutomationDb,
  userId: string,
  id: string,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(companyCandidates)
      .where(
        and(eq(companyCandidates.id, id), eq(companyCandidates.userId, userId)),
      )
      .returning();
    if (!row) throw new AppError(404, "Company not found.");
    if (row.sourceId)
      await tx
        .update(jobSources)
        .set({ enabled: false, schedule: "Manual", nextRunAt: null })
        .where(
          and(eq(jobSources.id, row.sourceId), eq(jobSources.ownerId, userId)),
        );
    if (row.watchlistId)
      await tx
        .delete(companyWatchlists)
        .where(
          and(
            eq(companyWatchlists.id, row.watchlistId),
            eq(companyWatchlists.userId, userId),
          ),
        );
    await recordActivity(tx, {
      userId,
      actor: "Application",
      stage: "company-removed",
      message: `${row.name}: company removed and scheduled scanning disabled.`,
    });
    return { id };
  });
}

export const pendingCompanyCondition = (now: Date) =>
  or(
    eq(companyCandidates.status, "Pending"),
    and(
      eq(companyCandidates.status, "Resolving"),
      lt(
        companyCandidates.lastCheckedAt,
        new Date(now.getTime() - 15 * 60_000),
      ),
    ),
  );
export async function pendingCompanies(db: AutomationDb, now = new Date()) {
  return db
    .select({ id: companyCandidates.id, userId: companyCandidates.userId })
    .from(companyCandidates)
    .where(pendingCompanyCondition(now))
    .orderBy(asc(companyCandidates.createdAt))
    .limit(20);
}
export async function claimCompany(
  db: AutomationDb,
  userId: string,
  id: string,
) {
  const now = new Date();
  const [row] = await db
    .update(companyCandidates)
    .set({
      status: "Resolving",
      error: "",
      attempts: sql`${companyCandidates.attempts} + 1`,
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(companyCandidates.id, id),
        eq(companyCandidates.userId, userId),
        pendingCompanyCondition(now),
      ),
    )
    .returning();
  return row ?? null;
}
