import { PgBoss } from "pg-boss";
import { getDb, getPool } from "@jobfinder/db";
import {
  recordWorkerHeartbeat,
  pendingCompanies,
  recordActivity,
} from "@jobfinder/automation";
import {
  resolveCompanyJobSchema,
  type ResolveCompanyJob,
  evaluateBatchJobSchema,
  housekeepingJobSchema,
  queueNames,
  scanSourceJobSchema,
  scheduleTickJobSchema,
  evaluationSingletonKey,
  type EvaluateBatchJob,
  type HousekeepingJob,
  type ScanSourceJob,
  type ScheduleTickJob,
} from "./queues";
import {
  runResolveCompanyJob,
  runEvaluationJob,
  runHousekeeping,
  runScanJob,
  runScheduleTick,
} from "./handlers";

const startedAt = new Date();

function log(
  level: "info" | "warn" | "error",
  event: string,
  detail: object = {},
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...detail,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

function connectionString() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required. See README.md.");
  return value;
}

/**
 * The worker is the only process that runs scheduled discovery, evaluation,
 * digest and cleanup work. Source scans hold one advisory lock per workspace,
 * and the scan queue runs one job at a time, so a slow feed cannot stack up.
 */
async function main() {
  const boss = new PgBoss({
    connectionString: connectionString(),
    schema: "pgboss",
    supervise: true,
    schedule: true,
  });
  boss.on("error", (error) =>
    log("error", "pg_boss_error", { message: error.message }),
  );
  boss.on("warning", (warning) =>
    log("warn", "pg_boss_warning", { message: warning.message }),
  );
  await boss.start();
  const db = getDb();

  await boss.createQueue(queueNames.resolveCompany, {
    // "stately" dedupes queued jobs as well as the running one. Under
    // "singleton" the scheduler tick re-sent every pending candidate each
    // minute and the backlog grew behind a wall of duplicates.
    policy: "stately",
    retryLimit: 0,
    expireInSeconds: 600,
  });
  await boss.createQueue(queueNames.scanSource, {
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 900,
    deleteAfterSeconds: 86_400,
  });
  await boss.createQueue(queueNames.evaluateBatch, {
    policy: "singleton",
    retryLimit: 1,
    retryDelay: 120,
    expireInSeconds: 900,
    deleteAfterSeconds: 86_400,
  });
  await boss.createQueue(queueNames.scheduleSources, {
    policy: "exclusive",
    retryLimit: 0,
    expireInSeconds: 120,
  });
  await boss.createQueue(queueNames.housekeeping, {
    policy: "exclusive",
    retryLimit: 0,
    expireInSeconds: 600,
  });

  // Recurring work is scheduled in UTC. `missed: once` keeps a worker that was
  // down for a while from replaying every skipped tick on restart.
  await boss.schedule(
    queueNames.scheduleSources,
    "* * * * *",
    {},
    { key: "scheduler", tz: "UTC", missed: "once" },
  );
  await boss.schedule(
    queueNames.housekeeping,
    "0 * * * *",
    {},
    { key: "housekeeping", tz: "UTC", missed: "once" },
  );

  await boss.work<ResolveCompanyJob>(
    queueNames.resolveCompany,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs)
        await runResolveCompanyJob(
          db,
          { data: resolveCompanyJobSchema.parse(job.data) },
          { signal: job.signal },
        );
    },
  );

  await boss.work<ScanSourceJob>(
    queueNames.scanSource,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs) {
        const payload = scanSourceJobSchema.parse(job.data);
        try {
          const result = await runScanJob(
            db,
            {
              enqueueEvaluation: async (next: EvaluateBatchJob) => {
                await boss.send(queueNames.evaluateBatch, next, {
                  singletonKey: evaluationSingletonKey(next.userId),
                  retryLimit: 1,
                  retryDelay: 120,
                });
              },
            },
            { id: job.id, data: payload },
            { signal: job.signal },
          );
          log("info", "scan_completed", result);
        } catch (error) {
          log("warn", "scan_failed", {
            jobId: job.id,
            sourceId: payload.sourceId,
            message: error instanceof Error ? error.message : "unknown",
          });
          await recordActivity(db, {
            userId: payload.userId,
            sourceId: payload.sourceId,
            actor: "Worker",
            stage: "retry",
            level: "error",
            message:
              "Scan failed; automatic retries are limited to two attempts. See the scan error for details.",
          });
          // Rethrow so pg-boss applies the queue's retry policy.
          throw error;
        }
      }
    },
  );

  await boss.work<EvaluateBatchJob>(
    queueNames.evaluateBatch,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs) {
        const payload = evaluateBatchJobSchema.parse(job.data);
        try {
          log("info", "evaluation_completed", {
            jobId: job.id,
            ...(await runEvaluationJob(db, { data: payload })),
          });
        } catch (error) {
          await recordActivity(db, {
            userId: payload.userId,
            actor: "Worker",
            stage: "evaluation-failed",
            level: "error",
            message:
              error instanceof Error ? error.message : "Evaluation failed.",
          });
          log("warn", "evaluation_failed", {
            jobId: job.id,
            message: error instanceof Error ? error.message : "unknown",
          });
          throw error;
        }
      }
    },
  );

  await boss.work<ScheduleTickJob>(
    queueNames.scheduleSources,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 },
    async (jobs) => {
      for (const job of jobs) {
        const payload = scheduleTickJobSchema.parse(job.data);
        const now = payload.requestedAt
          ? new Date(payload.requestedAt)
          : new Date();
        for (const company of await pendingCompanies(db, now)) {
          await boss.send(
            queueNames.resolveCompany,
            { userId: company.userId, candidateId: company.id },
            { singletonKey: `resolve:${company.id}` },
          );
        }
        const result = await runScheduleTick(
          db,
          async (next: ScanSourceJob, key: string) => {
            await boss.send(queueNames.scanSource, next, {
              singletonKey: key,
              retryLimit: 2,
              retryDelay: 60,
              retryBackoff: true,
            });
          },
          now,
        );
        if (result.claimed)
          log("info", "schedule_tick", { jobId: job.id, ...result });
      }
    },
  );

  await boss.work<HousekeepingJob>(
    queueNames.housekeeping,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 30 },
    async (jobs) => {
      for (const job of jobs) {
        const payload = housekeepingJobSchema.parse(job.data);
        const now = payload.requestedAt
          ? new Date(payload.requestedAt)
          : new Date();
        await recordActivity(db, {
          actor: "Worker",
          stage: "maintenance",
          message: "Running expired-record cleanup and due in-app digests.",
        });
        log("info", "housekeeping_completed", {
          jobId: job.id,
          ...(await runHousekeeping(db, now)),
        });
      }
    },
  );

  const heartbeat = async () => {
    try {
      const queueDepth: Record<string, number> = {};
      for (const name of Object.values(queueNames)) {
        const queue = await boss.getQueue(name);
        queueDepth[name] = queue ? queue.activeCount + queue.readyCount : 0;
      }
      await recordWorkerHeartbeat(db, {
        startedAt: startedAt.toISOString(),
        pid: process.pid,
        queueDepth,
      });
    } catch (error) {
      log("warn", "heartbeat_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  };
  await heartbeat();
  await recordActivity(db, {
    actor: "Worker",
    stage: "worker-start",
    message:
      "Worker started: company discovery, scheduled scans, evaluation and maintenance are available.",
  });
  const heartbeatTimer = setInterval(() => void heartbeat(), 60_000);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "worker_stopping", { signal });
    clearInterval(heartbeatTimer);
    await recordActivity(db, {
      actor: "Worker",
      stage: "worker-stop",
      message: "Worker is stopping; queued work will resume on restart.",
    });
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
    } finally {
      await getPool().end();
    }
    log("info", "worker_stopped", { signal });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log("info", "worker_started", {
    queues: Object.values(queueNames),
    startedAt: startedAt.toISOString(),
  });
}

main().catch((error) => {
  log("error", "worker_crashed", {
    message: error instanceof Error ? error.message : "unknown",
  });
  process.exit(1);
});
