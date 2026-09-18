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
import { recordActivity } from "./activity";

export async function importCompanies(
  db: AutomationDb,
  userId: string,
  text: string,
) {
  const parsed = parseSeedList(text);
  let imported = 0;
  let duplicates = 0;
  for (const row of parsed.rows) {
    const inserted = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .insert(companyCandidates)
        .values({
          userId,
          name: row.name,
          domain: row.domain,
          websiteUrl: row.websiteUrl ?? `https://${row.domain}/`,
        })
        .onConflictDoNothing()
        .returning();
      if (!candidate) return false;
      const key = watchlistKey(row.name);
      const [watch] = await tx
        .insert(companyWatchlists)
        .values({
          userId,
          company: row.name,
          companyKey: key,
          domain: row.domain,
        })
        .onConflictDoNothing()
        .returning();
      const existing =
        watch ??
        (
          await tx
            .select()
            .from(companyWatchlists)
            .where(
              and(
                eq(companyWatchlists.userId, userId),
                eq(companyWatchlists.companyKey, key),
              ),
            )
        )[0];
      // Distinct domains can have the same display name; do not repoint an unrelated watchlist.
      if (existing && (!existing.domain || existing.domain === row.domain)) {
        if (!existing.domain)
          await tx
            .update(companyWatchlists)
            .set({ domain: row.domain })
            .where(eq(companyWatchlists.id, existing.id));
        await tx
          .update(companyCandidates)
          .set({ watchlistId: existing.id })
          .where(eq(companyCandidates.id, candidate.id));
      }
      await recordActivity(tx, {
        userId,
        candidateId: candidate.id,
        actor: "Application",
        stage: "queued",
        message: `${row.name}: queued for website and careers discovery.`,
      });
      return true;
    });
    if (inserted) imported++;
    else duplicates++;
  }
  return { imported, duplicates, rejected: parsed.rejected };
}

export async function listCompanies(db: AutomationDb, userId: string) {
  const rows = await db
    .select({ candidate: companyCandidates, source: jobSources })
    .from(companyCandidates)
    .leftJoin(jobSources, eq(jobSources.id, companyCandidates.sourceId))
    .where(eq(companyCandidates.userId, userId))
    .orderBy(asc(companyCandidates.name));
  const runs = await db
    .select()
    .from(searchRuns)
    .where(eq(searchRuns.userId, userId))
    .orderBy(desc(searchRuns.startedAt))
    .limit(500);
  return rows.map((row) => ({
    ...row,
    lastRun: runs.find((run) => run.sourceId === row.source?.id) ?? null,
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
