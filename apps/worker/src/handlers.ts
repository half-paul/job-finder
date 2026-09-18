import { and, eq } from "drizzle-orm";
import {
  companyCandidates,
  companyWatchlists,
  jobSources,
} from "@jobfinder/db";
import {
  resolveCompanyWebsite,
  RobotsBlockedError,
} from "@jobfinder/discovery";
import type { ConnectorOptions } from "@jobfinder/job-sources";
import type { ScanSchedule } from "@jobfinder/shared";
import {
  cleanupExpired,
  claimCompany,
  sourceIdentity,
  recordActivity,
  claimDueSources,
  digestDueUsers,
  evaluateSyncedJobs,
  generateDigest,
  markSourceChecked,
  recordMatchNotifications,
  recordState,
  scanSourceRecord,
  schedulerHeartbeatKey,
  type AutomationDb,
} from "@jobfinder/automation";
import {
  scanSingletonKey,
  type EvaluateBatchJob,
  type ScanSourceJob,
} from "./queues";

/** The worker's outbound port, so handlers can be tested without pg-boss. */
export interface JobQueue {
  enqueueEvaluation: (job: EvaluateBatchJob) => Promise<void>;
}

export interface ScanJobResult {
  runId: string;
  status: string;
  added: number;
  updated: number;
  removed: number;
  filtered: number;
  failed: string | null;
  evaluationQueued: boolean;
}

/**
 * One scheduled source scan. A retried job reuses the same run row because the
 * pg-boss job id is the run id, so a crash mid-scan never leaves two runs for
 * one slot. Partial scans never mark listings removed.
 */
export async function runScanJob(
  db: AutomationDb,
  queue: JobQueue,
  job: { id: string; data: ScanSourceJob },
  options: { connectorOptions?: ConnectorOptions; signal?: AbortSignal } = {},
): Promise<ScanJobResult> {
  const payload = job.data;
  const run = await scanSourceRecord({
    userId: payload.userId,
    sourceId: payload.sourceId,
    trigger: "Schedule",
    runId: job.id,
    connectorOptions: options.connectorOptions,
    signal: options.signal,
  });
  await markSourceChecked(db, {
    sourceId: payload.sourceId,
    schedule: payload.schedule as ScanSchedule,
  });
  // Nothing changed, so there is nothing new to evaluate or alert on.
  const changed = run.added + run.updated > 0;
  if (changed && ["Succeeded", "Partial"].includes(run.status))
    await queue.enqueueEvaluation({
      userId: payload.userId,
      runIds: [run.id],
    });
  return {
    runId: run.id,
    status: run.status,
    added: run.added,
    updated: run.updated,
    removed: run.removed,
    filtered: run.filtered,
    failed: run.error ?? null,
    evaluationQueued: changed,
  };
}

export interface EvaluationJobResult {
  evaluated: number;
  blocked: number;
  failed: number;
  alerts: number;
  enabled: boolean;
  /** First few reasons a scheduled evaluation could not complete. */
  errors: string[];
}

/**
 * Evaluation and alerting run in one handler so a retry cannot evaluate without
 * also recording the alerts, and vice versa. Alert inserts are idempotent.
 */
export async function runEvaluationJob(
  db: AutomationDb,
  job: { data: EvaluateBatchJob },
): Promise<EvaluationJobResult> {
  await recordActivity(db, {
    userId: job.data.userId,
    actor: "Worker",
    stage: "evaluation",
    message: "Starting evaluation of new or changed listings.",
  });
  const evaluation = await evaluateSyncedJobs(job.data.userId, {
    runIds: job.data.runIds,
  });
  const alerts = await recordMatchNotifications(job.data.userId, { db });
  await recordActivity(db, {
    userId: job.data.userId,
    actor: "Worker",
    stage: "evaluation-complete",
    message: `${evaluation.evaluated} evaluated, ${evaluation.blocked} blocked, ${evaluation.failed} failed, ${alerts} in-app alerts. ${evaluation.errors.slice(0, 3).join(" ")}`,
  });
  return {
    evaluated: evaluation.evaluated,
    blocked: evaluation.blocked,
    failed: evaluation.failed,
    enabled: evaluation.enabled,
    alerts,
    errors: evaluation.errors.slice(0, 3),
  };
}

export interface ScheduleTickResult {
  claimed: number;
  skipped: number;
}

/**
 * Claims due sources and hands each one to the scan queue. Claiming advances
 * `next_run_at` first, so a duplicated tick cannot enqueue the same slot twice.
 */
export async function runScheduleTick(
  db: AutomationDb,
  enqueue: (job: ScanSourceJob, singletonKey: string) => Promise<void>,
  now = new Date(),
): Promise<ScheduleTickResult> {
  const due = await claimDueSources(db, now);
  let enqueued = 0;
  for (const source of due) {
    await enqueue(
      {
        userId: source.userId,
        sourceId: source.sourceId,
        schedule: source.schedule,
      },
      scanSingletonKey(source.userId, source.sourceId),
    );
    await recordActivity(db, {
      userId: source.userId,
      sourceId: source.sourceId,
      actor: "Worker",
      stage: "scan-queued",
      message: "Scheduled scan queued.",
    });
    enqueued++;
  }
  await recordState(db, schedulerHeartbeatKey, {
    checkedAt: now.toISOString(),
    due: due.length,
    enqueued,
  });
  return { claimed: due.length, skipped: due.length - enqueued };
}

export interface HousekeepingResult {
  removedSessions: number;
  removedRateLimits: number;
  removedNotifications: number;
  digests: number;
}

/**
 * Expired-row cleanup plus the opt-in daily digest. No email, SMS or push
 * message is ever sent: a digest is stored as an in-app notification.
 */
export async function runHousekeeping(
  db: AutomationDb,
  now = new Date(),
): Promise<HousekeepingResult> {
  const cleaned = await cleanupExpired(db, now);
  let digests = 0;
  for (const userId of await digestDueUsers(db, now)) {
    await generateDigest(userId, { db, windowHours: 24, now });
    await recordActivity(db, {
      userId,
      actor: "Worker",
      stage: "digest",
      message: "Daily in-app digest generated.",
    });
    digests++;
  }
  return {
    removedSessions: cleaned.sessions,
    removedRateLimits: cleaned.rateLimits,
    removedNotifications: cleaned.notifications,
    digests,
  };
}

/** Candidate claims and final writes are fenced by attempt number, including after a worker restart. */
export async function runResolveCompanyJob(
  db: AutomationDb,
  job: { data: { userId: string; candidateId: string } },
  options: import("@jobfinder/discovery").DiscoveryOptions = {},
) {
  const { userId, candidateId } = job.data;
  const candidate = await claimCompany(db, userId, candidateId);
  if (!candidate) return { skipped: true };
  const progress = (stage: string, message: string) =>
    recordActivity(db, {
      userId,
      candidateId,
      actor: "Worker",
      stage,
      message: `${candidate.name}: ${message}`,
    });
  try {
    const resolution = await resolveCompanyWebsite(
      candidate.websiteUrl ?? `https://${candidate.domain}/`,
      { ...options, onProgress: progress },
    );
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(companyCandidates)
        .where(
          and(
            eq(companyCandidates.id, candidateId),
            eq(companyCandidates.userId, userId),
          ),
        )
        .for("update");
      if (
        !current ||
        current.status !== "Resolving" ||
        current.attempts !== candidate.attempts
      )
        return;
      const values = {
        ownerId: userId,
        provider: resolution.provider,
        board: resolution.board,
        company: candidate.name,
        sourceUrl: resolution.careersUrl,
        identity: sourceIdentity({
          provider: resolution.provider,
          board: resolution.board,
        }),
        enabled: true,
        schedule: "Every 4 hours",
        nextRunAt: new Date(),
      };
      const [source] = await tx
        .insert(jobSources)
        .values(values)
        .onConflictDoUpdate({
          target: [jobSources.ownerId, jobSources.identity],
          set: values,
        })
        .returning();
      if (candidate.sourceId && candidate.sourceId !== source.id)
        await tx
          .update(jobSources)
          .set({ enabled: false, nextRunAt: null, schedule: "Manual" })
          .where(
            and(
              eq(jobSources.id, candidate.sourceId),
              eq(jobSources.ownerId, userId),
            ),
          );
      await tx
        .update(companyCandidates)
        .set({
          status: "Resolved",
          careersUrl: resolution.careersUrl,
          sourceId: source.id,
          strategy: resolution.strategy,
          ats: resolution.ats,
          atsKey: resolution.strategy === "ats" ? resolution.board : null,
          policyCheck: resolution.policy,
          updatedAt: new Date(),
          error: "",
        })
        .where(eq(companyCandidates.id, candidateId));
      if (candidate.watchlistId)
        await tx
          .update(companyWatchlists)
          .set({
            sourceId: source.id,
            provider:
              resolution.strategy === "ats" ? resolution.provider : null,
            board: resolution.board,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(companyWatchlists.id, candidate.watchlistId),
              eq(companyWatchlists.userId, userId),
            ),
          );
      await recordActivity(tx, {
        userId,
        candidateId,
        sourceId: source.id,
        actor: "Worker",
        stage: "resolved",
        message: `${candidate.name}: careers source ready. First scan is due now; refreshes run every 4 hours.`,
      });
    });
    return { resolved: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Company discovery failed.";
    const [failed] = await db
      .update(companyCandidates)
      .set({
        status: error instanceof RobotsBlockedError ? "Blocked" : "Failed",
        error: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(companyCandidates.id, candidateId),
          eq(companyCandidates.userId, userId),
          eq(companyCandidates.attempts, candidate.attempts),
          eq(companyCandidates.status, "Resolving"),
        ),
      )
      .returning();
    if (failed)
      await recordActivity(db, {
        userId,
        candidateId,
        actor: "Worker",
        stage: "discovery-failed",
        level: "error",
        message: `${candidate.name}: ${message}`,
      });
    return { failed: true };
  }
}
