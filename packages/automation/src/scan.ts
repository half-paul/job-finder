import {
  createAdaptiveCareersConnector,
  type ExtractPage,
} from "@jobfinder/discovery";
import { recordActivities, recordActivity } from "./activity";
import { discoveryExtractor } from "./discovery-ai";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  getPool,
  companyCandidates,
  jobReferences,
  jobSources,
  jobs,
  preferences,
  schema,
  searchRuns,
} from "@jobfinder/db";
import {
  AppError,
  defaultPreferences,
  isGlobalSource,
  keywordFilter,
  preferencesSchema,
} from "@jobfinder/shared";
import { canonicalUrl, digest } from "@jobfinder/shared/hash";
import {
  createConnector,
  providerName,
  type ConnectorOptions,
  type JobReference,
  type NormalizedJob,
  type SearchCursor,
} from "@jobfinder/job-sources";

/** The typed client every automation service reads and writes through. */
export type AutomationDb = NodePgDatabase<typeof schema>;

export type ScanTrigger = "Manual" | "Schedule";

export interface ScanSourceOptions {
  userId: string;
  sourceId: string;
  trigger?: ScanTrigger;
  /**
   * Deterministic run id. The worker passes the pg-boss job id so a retried job
   * resumes the same run row instead of creating a second one.
   */
  runId?: string;
  /** Transport injection for deterministic tests; never populated from config. */
  connectorOptions?: ConnectorOptions;
  /** Aborts in-flight provider requests when the worker is shutting down. */
  signal?: AbortSignal;
  extractPage?: ExtractPage;
}

export type SearchRunRow = typeof searchRuns.$inferSelect;

export function sourceIdentity(input: {
  provider: string;
  board: string;
  sourceUrl?: string | null;
}) {
  if (input.provider === "JSON-LD" && input.sourceUrl)
    return canonicalUrl(input.sourceUrl);
  return `${input.provider}:${
    isGlobalSource(input.provider) ? input.provider.toLowerCase() : input.board
  }`;
}

/**
 * Runs one source scan behind the existing per-user advisory lock. The lock is
 * held on a dedicated session so a long network walk never blocks other
 * transactions. Both the interactive endpoint and the worker call this.
 */
export async function scanSourceRecord(
  options: ScanSourceOptions,
): Promise<SearchRunRow> {
  const client = await getPool().connect();
  let locked = false;
  let releaseError: Error | undefined;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('jobfinder:discovery'), hashtext($1)) AS locked",
      [options.userId],
    );
    locked = result.rows[0].locked;
    if (!locked)
      throw new AppError(
        409,
        "A source sync is already running in your workspace. Try again when it finishes.",
      );
    return await scanSourceWithDb(options, drizzle({ client, schema }));
  } finally {
    if (locked) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('jobfinder:discovery'), hashtext($1))",
          [options.userId],
        );
      } catch (error) {
        releaseError =
          error instanceof Error
            ? error
            : new Error("Could not release discovery lock");
      }
    }
    client.release(releaseError);
  }
}

export async function scanSourceWithDb(
  options: ScanSourceOptions,
  db: AutomationDb,
): Promise<SearchRunRow> {
  const { userId, sourceId } = options;
  const trigger: ScanTrigger = options.trigger ?? "Manual";
  const [source] = await db
    .select()
    .from(jobSources)
    .where(and(eq(jobSources.id, sourceId), eq(jobSources.ownerId, userId)));
  if (!source) throw new AppError(404, "Source not found.");
  if (!source.enabled) throw new AppError(409, "This source is disabled.");
  if (source.provider === "Jobicy") {
    const [previous] = await db
      .select()
      .from(searchRuns)
      .where(
        and(
          eq(searchRuns.sourceId, source.id),
          eq(searchRuns.status, "Succeeded"),
        ),
      )
      .orderBy(desc(searchRuns.startedAt))
      .limit(1);
    if (previous && Date.now() - previous.startedAt.getTime() < 3_600_000)
      return {
        ...previous,
        id: options.runId ?? previous.id,
        added: 0,
        updated: 0,
        removed: 0,
        filtered: 0,
        warnings: [
          "Using the latest Jobicy scan. This feed refreshes at most once per hour.",
        ],
      };
  }

  const [preferenceRow] = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId));
  // Keyword rules are read once per scan so imports stay consistent even if
  // preferences change while a long feed is being walked.
  const settings = preferencesSchema.parse(
    preferenceRow?.data ?? defaultPreferences,
  );

  const run = await startRun(db, {
    id: options.runId,
    sourceId: source.id,
    userId,
    trigger,
  });
  const startedAt = Date.now();
  const actor = trigger === "Schedule" ? "Worker" : "Application";
  const event = (stage: string, message: string) => ({
    userId,
    sourceId,
    runId: run.id,
    actor,
    stage,
    message: `${source.company || source.provider}: ${message}`,
  });
  const progress = (stage: string, message: string) =>
    recordActivity(db, event(stage, message));
  // Only warnings are written per listing now, still buffered: an import that
  // logged every listing made activity_events the largest table in the
  // database and the slowest read on the feed's two-second poll. Counts for
  // added, updated and filtered listings live on the run summary instead.
  const buffered: ReturnType<typeof event>[] = [];
  const flushProgress = async () => {
    if (!buffered.length) return;
    const batch = buffered.splice(0, buffered.length);
    await recordActivities(db, batch);
  };
  const bufferProgress = async (stage: string, message: string) => {
    buffered.push(event(stage, message));
    if (buffered.length >= 50) await flushProgress();
  };
  await progress(
    "scan-start",
    `Starting ${trigger.toLowerCase()} scan using ${source.provider}.`,
  );
  try {
    const provider = providerName(source.provider);
    if (provider === "Careers") {
      const [approved] = await db
        .select()
        .from(companyCandidates)
        .where(
          and(
            eq(companyCandidates.userId, userId),
            eq(companyCandidates.sourceId, sourceId),
            // A re-resolution in flight leaves the candidate Pending or
            // Resolving. The approval it already earned still stands, so the
            // scheduled scan must not fail for the duration of the retry.
            inArray(companyCandidates.status, [
              "Resolved",
              "Pending",
              "Resolving",
            ]),
          ),
        );
      if (!approved?.policyCheck?.robotsAllowed)
        throw new AppError(
          409,
          "Company discovery must approve this careers source before scanning.",
        );
    }
    const connector =
      provider === "Careers"
        ? createAdaptiveCareersConnector({
            ...options.connectorOptions,
            onProgress: progress,
            extractPage:
              options.extractPage ??
              discoveryExtractor(db, userId, {
                sourceId,
                runId: run.id,
                actor,
              }),
          })
        : createConnector(provider, {
            ...options.connectorOptions,
            jsonLdAllowedHosts:
              options.connectorOptions?.jsonLdAllowedHosts ??
              (process.env.JSON_LD_ALLOWED_HOSTS ?? "")
                .split(",")
                .map((host) => host.trim().toLowerCase())
                .filter(Boolean),
          });
    const query = {
      board: source.board,
      terms: [],
      company: source.company,
      sourceUrl: source.sourceUrl ?? undefined,
    };
    const initialCursor: SearchCursor | undefined =
      source.etag || source.lastModified
        ? {
            etag: source.etag ?? undefined,
            lastModified: source.lastModified ?? undefined,
          }
        : undefined;
    await progress("fetch", "Requesting job listings.");
    let page = await connector.search(query, initialCursor, options.signal);
    const warnings: string[] = [];
    let canMarkRemovals = true;
    const seen: string[] = [];
    let added = 0;
    let updated = 0;
    let discovered = 0;
    let filtered = 0;
    let cursor = page.next;
    const maxJobs = 5000;

    while (true) {
      if (page.canMarkRemovals === false) canMarkRemovals = false;
      if (!page.notModified) {
        discovered += page.jobs.length;
        await progress(
          "page",
          `Received ${page.jobs.length} listings; processing and applying keyword filters.`,
        );
        let processed = 0;
        for (const reference of page.jobs) {
          const fullReference: JobReference = {
            ...reference,
            board: source.board,
            company: source.company,
            sourceUrl: source.sourceUrl ?? undefined,
          };
          seen.push(reference.externalId);
          try {
            const raw = await connector.fetchJob(fullReference, options.signal);
            const normalized = await connector.normalize(raw, { query });
            // The external id is already recorded as seen, so a listing that
            // is skipped here is never marked removed by an incomplete match.
            // Previously imported listings therefore stay untouched.
            if (!keywordFilter(normalized, settings).passed) {
              filtered++;
              continue;
            }
            const result = await upsertDiscoveredJob(
              db,
              userId,
              source.id,
              normalized,
            );
            if (result === "added") added++;
            if (result === "updated") updated++;
            // Counted in the run summary rather than written per listing.
          } catch (error) {
            const warning = `${reference.externalId}: ${
              error instanceof Error ? error.message : "could not read posting"
            }`;
            await bufferProgress("warning", warning);
            warnings.push(warning);
          } finally {
            processed++;
            if (processed % 10 === 0)
              await db
                .update(searchRuns)
                .set({ discovered, added, updated, filtered })
                .where(eq(searchRuns.id, run.id));
          }
        }
        await flushProgress();
      }
      await db
        .update(searchRuns)
        .set({
          discovered,
          added,
          updated,
          filtered,
          warnings: warnings.slice(0, 100),
        })
        .where(eq(searchRuns.id, run.id));
      const complete = page.complete || page.notModified;
      if (!complete && (!cursor || seen.length >= maxJobs)) {
        return await finishRun(db, run.id, {
          status: "Partial",
          startedAt,
          values: {
            discovered,
            added,
            updated,
            removed: 0,
            filtered,
            warnings: [
              cursor
                ? `Scan stopped at the ${maxJobs}-job safety cap; no removals were marked.`
                : "Source returned an incomplete page without a continuation cursor; no removals were marked.",
              ...keywordWarnings(filtered),
              ...warnings.slice(0, 99),
            ].slice(0, 100),
          },
        });
      }
      if (complete) break;
      page = await connector.search(query, cursor, options.signal);
      cursor = page.next;
    }

    if (!page.notModified) {
      const removed = canMarkRemovals
        ? await deactivateMissingReferences(db, source.id, seen)
        : 0;
      if (!canMarkRemovals)
        warnings.push(
          "This scan cannot prove the complete job inventory. Missing listings are not marked removed.",
        );
      await db
        .update(jobSources)
        .set({
          etag: page.next?.etag ?? null,
          lastModified: page.next?.lastModified ?? null,
        })
        .where(eq(jobSources.id, source.id));
      return await finishRun(db, run.id, {
        status: "Succeeded",
        startedAt,
        values: {
          discovered,
          added,
          updated,
          removed,
          filtered,
          warnings: [...keywordWarnings(filtered), ...warnings].slice(0, 100),
        },
      });
    }

    return await finishRun(db, run.id, {
      status: "Succeeded",
      startedAt,
      values: {
        discovered,
        added,
        updated,
        removed: 0,
        filtered,
        warnings: ["Source was not modified since the previous complete scan."],
      },
    });
  } catch (error) {
    // Buffered listing progress explains what the scan managed before it
    // failed, so it is written before the failure event.
    await flushProgress().catch(() => undefined);
    await db
      .update(searchRuns)
      .set({
        status: "Failed",
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Source scan failed",
      })
      .where(eq(searchRuns.id, run.id));
    await recordActivity(db, {
      userId,
      sourceId,
      runId: run.id,
      actor,
      stage: "scan-failed",
      level: "error",
      message: `${source.company}: ${error instanceof Error ? error.message : "Scan failed"}`,
    });
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      error instanceof Error ? error.message : "The source scan failed.",
    );
  }
}

/**
 * Creates the run row, or resets it when a worker retries the same job id. The
 * reset keeps a retry visible as one run instead of a phantom duplicate.
 */
async function startRun(
  db: AutomationDb,
  input: {
    id?: string;
    sourceId: string;
    userId: string;
    trigger: ScanTrigger;
  },
) {
  const values = {
    ...(input.id ? { id: input.id } : {}),
    sourceId: input.sourceId,
    userId: input.userId,
    trigger: input.trigger,
    status: "Running" as const,
    startedAt: new Date(),
    finishedAt: null,
    discovered: 0,
    added: 0,
    updated: 0,
    removed: 0,
    filtered: 0,
    warnings: [],
    error: null,
    durationMs: null,
  };
  const [row] = await db
    .insert(searchRuns)
    .values(values)
    .onConflictDoUpdate({ target: searchRuns.id, set: values })
    .returning();
  return row;
}

async function finishRun(
  db: AutomationDb,
  id: string,
  input: {
    status: "Succeeded" | "Partial";
    startedAt: number;
    values: {
      discovered: number;
      added: number;
      updated: number;
      removed: number;
      filtered: number;
      warnings: string[];
    };
  },
) {
  const [row] = await db
    .update(searchRuns)
    .set({
      ...input.values,
      status: input.status,
      finishedAt: new Date(),
      durationMs: Date.now() - input.startedAt,
    })
    .where(eq(searchRuns.id, id))
    .returning();
  await recordActivity(db, {
    userId: row.userId,
    sourceId: row.sourceId,
    runId: row.id,
    actor: row.trigger === "Schedule" ? "Worker" : "Application",
    stage: "scan-complete",
    level: input.status === "Partial" ? "warning" : "info",
    message: `${input.status}: ${row.discovered} found, ${row.added} added, ${row.updated} updated, ${row.filtered} filtered, ${row.removed} removed. ${row.warnings.join(" ")}`,
  });
  return row;
}

const keywordWarnings = (filtered: number) =>
  filtered
    ? [
        `${filtered} ${filtered === 1 ? "listing was" : "listings were"} skipped by your keyword filters.`,
      ]
    : [];

async function upsertDiscoveredJob(
  db: AutomationDb,
  userId: string,
  sourceId: string,
  normalized: NormalizedJob,
): Promise<"added" | "updated" | "unchanged"> {
  const jobUrl = canonicalUrl(normalized.jobUrl);
  const canonicalHash = digest(jobUrl);
  const values = {
    ownerId: userId,
    title: normalized.title,
    company: normalized.company,
    description: normalized.description,
    location: normalized.location,
    country: normalized.country,
    industry: normalized.industry,
    employmentType: normalized.employmentType,
    seniority: normalized.seniority,
    workType: normalized.workType,
    salaryMin: normalized.salaryMin,
    salaryMax: normalized.salaryMax,
    salaryPeriod: normalized.salaryPeriod,
    currency: normalized.currency,
    jobUrl,
    canonicalHash,
    descriptionHash: normalized.descriptionHash,
    source: normalized.provider,
    lifecycle: "Active",
    postedAt: normalized.postedAt ? new Date(normalized.postedAt) : null,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select({
      id: jobs.id,
      descriptionHash: jobs.descriptionHash,
    })
    .from(jobs)
    .where(
      and(eq(jobs.ownerId, userId), eq(jobs.canonicalHash, canonicalHash)),
    );
  let jobId = existing?.id;
  if (!existing) {
    const [job] = await db
      .insert(jobs)
      .values(values)
      .returning({ id: jobs.id });
    jobId = job.id;
  } else if (existing.descriptionHash !== normalized.descriptionHash) {
    await db.update(jobs).set(values).where(eq(jobs.id, existing.id));
  } else {
    await db
      .update(jobs)
      .set({ lastSeenAt: new Date(), lifecycle: "Active" })
      .where(eq(jobs.id, existing.id));
  }
  await db
    .insert(jobReferences)
    .values({
      jobId,
      sourceId,
      externalId: normalized.externalId,
      url: normalized.sourceUrl,
      active: true,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [jobReferences.sourceId, jobReferences.externalId],
      set: {
        jobId,
        active: true,
        url: normalized.sourceUrl,
        lastSeenAt: new Date(),
      },
    });
  return !existing
    ? "added"
    : existing.descriptionHash === normalized.descriptionHash
      ? "unchanged"
      : "updated";
}

async function deactivateMissingReferences(
  db: AutomationDb,
  sourceId: string,
  seen: string[],
) {
  const active = await db
    .select({
      jobId: jobReferences.jobId,
      externalId: jobReferences.externalId,
    })
    .from(jobReferences)
    .where(
      and(eq(jobReferences.sourceId, sourceId), eq(jobReferences.active, true)),
    );
  const missing = active.filter(
    (reference) => !seen.includes(reference.externalId),
  );
  for (const reference of missing) {
    await db
      .update(jobReferences)
      .set({ active: false, lastSeenAt: new Date() })
      .where(
        and(
          eq(jobReferences.sourceId, sourceId),
          eq(jobReferences.externalId, reference.externalId),
        ),
      );
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobReferences)
      .where(
        and(
          eq(jobReferences.jobId, reference.jobId),
          eq(jobReferences.active, true),
        ),
      );
    if (count === 0)
      await db
        .update(jobs)
        .set({
          lifecycle: "Removed",
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, reference.jobId));
  }
  return missing.length;
}
