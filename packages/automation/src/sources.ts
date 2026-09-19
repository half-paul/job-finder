import { and, desc, eq, inArray } from "drizzle-orm";
import { jobSources, searchRuns } from "@jobfinder/db";
import { personioBoardHost } from "@jobfinder/job-sources";
import {
  AppError,
  isGlobalSource,
  sourceInputSchema,
  sourceScheduleSchema,
  type ScanSchedule,
} from "@jobfinder/shared";
import { canonicalUrl } from "@jobfinder/shared/hash";
import { applySchedule } from "./schedule";
import { sourceIdentity, type AutomationDb } from "./scan";

/**
 * Sources owned by the signed-in user, each with its latest scan. Shared by the
 * discovery page, the diagnostics view and the interactive sync.
 */
export async function listSources(db: AutomationDb, userId: string) {
  const sources = await db
    .select()
    .from(jobSources)
    .where(eq(jobSources.ownerId, userId))
    .orderBy(desc(jobSources.enabled), jobSources.provider, jobSources.board);
  if (!sources.length) return [];
  const runs = await db
    .select()
    .from(searchRuns)
    .where(
      inArray(
        searchRuns.sourceId,
        sources.map((source) => source.id),
      ),
    )
    .orderBy(desc(searchRuns.startedAt));
  return sources.map((source) => ({
    source,
    lastRun: runs.find((run) => run.sourceId === source.id) ?? null,
  }));
}

export async function createSource(
  db: AutomationDb,
  userId: string,
  body: unknown,
) {
  const input = sourceInputSchema.parse(body);
  const global = isGlobalSource(input.provider);
  const identity = sourceIdentity({
    provider: input.provider,
    board: global ? input.provider.toLowerCase() : input.board,
    sourceUrl: input.sourceUrl,
  });
  const allowedHosts = (process.env.JSON_LD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  // A Personio board becomes the request hostname, so it is validated here as
  // well as in the connector: an invalid board must never reach a stored source.
  if (input.provider === "Personio") {
    try {
      personioBoardHost(input.board);
    } catch {
      throw new AppError(
        400,
        "Personio board must be a subdomain or a jobs.personio.de/.com hostname.",
      );
    }
  }
  if (input.provider === "JSON-LD") {
    if (!allowedHosts.length)
      throw new AppError(
        400,
        "Configure JSON_LD_ALLOWED_HOSTS before adding a JSON-LD source.",
      );
    const hostname = new URL(input.sourceUrl!).hostname.toLowerCase();
    const permitted = allowedHosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
    if (!permitted)
      throw new AppError(400, "That JSON-LD host is not allowlisted.");
  }
  const [source] = await db
    .insert(jobSources)
    .values({
      ownerId: userId,
      identity,
      company: global
        ? input.provider
        : input.company ||
          new URL(input.sourceUrl ?? "https://example.invalid").hostname,
      provider: input.provider,
      board: global ? input.provider.toLowerCase() : input.board || "json-ld",
      sourceUrl:
        input.provider === "JSON-LD" ? canonicalUrl(input.sourceUrl!) : null,
      enabled: true,
      schedule: "Manual",
      nextRunAt: null,
    })
    .onConflictDoNothing()
    .returning();
  if (!source) throw new AppError(409, "That source has already been added.");
  return source;
}

/** Schedules are applied on aligned UTC boundaries, never mid-interval. */
export async function setSourceSchedule(
  db: AutomationDb,
  userId: string,
  sourceId: string,
  body: unknown,
) {
  const input = sourceScheduleSchema.parse(body);
  const [source] = await db
    .select()
    .from(jobSources)
    .where(and(eq(jobSources.id, sourceId), eq(jobSources.ownerId, userId)));
  if (!source) throw new AppError(404, "Source not found.");
  if (!source.enabled && input.schedule !== "Manual")
    throw new AppError(409, "Enable this source before scheduling it.");
  const updated = await applySchedule(db, {
    sourceId,
    schedule: input.schedule,
  });
  return { ...updated, nextRunAtLabel: nextRunLabel(input.schedule, updated) };
}

const nextRunLabel = (
  schedule: ScanSchedule,
  row: { nextRunAt: Date | null },
) =>
  schedule === "Manual" || !row.nextRunAt
    ? "Runs only when you sync"
    : `Next automatic run ${row.nextRunAt.toISOString()}`;
