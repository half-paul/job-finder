import { desc, eq, inArray } from "drizzle-orm";
import { jobSources, searchRuns } from "@jobfinder/db";
import type { ScanSchedule } from "@jobfinder/shared";
import { unreadNotificationCount } from "./notifications";
import {
  readState,
  schedulerHeartbeatKey,
  workerHeartbeatKey,
} from "./schedule";
import type { AutomationDb } from "./scan";

export interface WorkerHealth {
  heartbeatAt: Date | null;
  healthy: boolean;
  detail: Record<string, unknown> | null;
  schedulerAt: Date | null;
}

const heartbeatWindowMs = 5 * 60_000;

/**
 * Worker liveness for the diagnostics view. A stale or missing heartbeat is
 * reported as unhealthy rather than hidden, so a stopped worker is visible.
 */
export async function workerHealth(db: AutomationDb): Promise<WorkerHealth> {
  const [heartbeat, scheduler] = await Promise.all([
    readState(db, workerHeartbeatKey),
    readState(db, schedulerHeartbeatKey),
  ]);
  const heartbeatAt = heartbeat?.updatedAt ?? null;
  return {
    heartbeatAt,
    healthy: Boolean(
      heartbeatAt && Date.now() - heartbeatAt.getTime() < heartbeatWindowMs,
    ),
    detail: heartbeat?.value ?? null,
    schedulerAt: scheduler?.updatedAt ?? null,
  };
}

export interface SourceDiagnostic {
  id: string;
  provider: string;
  board: string;
  company: string;
  enabled: boolean;
  schedule: ScanSchedule;
  nextRunAt: Date | null;
  lastCheckedAt: Date | null;
  lastRun: typeof searchRuns.$inferSelect | null;
}

/**
 * The diagnostics view answers "which source is healthy, what did it find, and
 * when does it run next" without exposing any other user's data.
 */
export async function automationOverview(db: AutomationDb, userId: string) {
  const sources = await db
    .select()
    .from(jobSources)
    .where(eq(jobSources.ownerId, userId))
    .orderBy(desc(jobSources.enabled), jobSources.provider, jobSources.board);
  const runs = sources.length
    ? await db
        .select()
        .from(searchRuns)
        .where(
          inArray(
            searchRuns.sourceId,
            sources.map((source) => source.id),
          ),
        )
        .orderBy(desc(searchRuns.startedAt))
        .limit(50)
    : [];
  const sourceDiagnostics: SourceDiagnostic[] = sources.map((source) => ({
    id: source.id,
    provider: source.provider,
    board: source.board,
    company: source.company,
    enabled: source.enabled,
    schedule: source.schedule as ScanSchedule,
    nextRunAt: source.nextRunAt,
    lastCheckedAt: source.lastCheckedAt,
    lastRun: runs.find((run) => run.sourceId === source.id) ?? null,
  }));
  const [notifications, health] = await Promise.all([
    unreadNotificationCount(db, userId),
    workerHealth(db),
  ]);
  return {
    worker: health,
    sources: sourceDiagnostics,
    runs: runs.slice(0, 20),
    unreadNotifications: notifications,
  };
}
