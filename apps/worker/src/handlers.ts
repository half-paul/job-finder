import type { ConnectorOptions } from "@jobfinder/job-sources";
import type { ScanSchedule } from "@jobfinder/shared";
import {
  cleanupExpired,
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
  const evaluation = await evaluateSyncedJobs(job.data.userId, {
    runIds: job.data.runIds,
  });
  const alerts = await recordMatchNotifications(job.data.userId, { db });
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
    digests++;
  }
  return {
    removedSessions: cleaned.sessions,
    removedRateLimits: cleaned.rateLimits,
    removedNotifications: cleaned.notifications,
    digests,
  };
}
