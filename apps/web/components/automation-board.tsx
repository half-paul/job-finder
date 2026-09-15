"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, CalendarClock, Play } from "lucide-react";
import { scanSchedules, type ScanSchedule } from "@jobfinder/shared";
import type { automation } from "../lib/automation";
import { api } from "./client";
import { Button } from "./ui/button";

type Overview = Awaited<ReturnType<typeof automation.overview>>;
type Digest = Awaited<ReturnType<typeof automation.digest>>["digest"];

const when = (value: Date | string | null | undefined) =>
  value ? new Date(value).toLocaleString("en-CA") : "—";

/**
 * Diagnostics for the automation pipeline: worker liveness, per-source
 * schedule and last result, and the recent search-run history. The worker is
 * the only process that runs scheduled work; this view reports what it did.
 */
export function AutomationBoard({ overview }: { overview: Overview }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [digest, setDigest] = useState<Digest | null>(null);

  async function run(
    key: string,
    action: () => Promise<unknown>,
    done: string,
  ) {
    setBusy(key);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(done);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const worker = overview.worker;
  const sourceName = (sourceId: string) =>
    overview.sources.find((source) => source.id === sourceId)?.company ??
    "Unknown source";

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AUTOMATION</span>
          <h1>Know what ran, and what runs next.</h1>
          <p>
            Scheduled scans, evaluation batches, digests and expired-row cleanup
            run in the worker. Nothing is emailed or messaged: alerts and the
            digest stay inside your workspace until you read them.
          </p>
        </div>
      </div>
      <div className="stats-grid">
        <div className="stat-card">
          <div>
            Worker
            <Activity size={15} />
          </div>
          <strong>{worker.healthy ? "Healthy" : "Not running"}</strong>
          <small>
            {worker.heartbeatAt
              ? `Last heartbeat ${when(worker.heartbeatAt)}`
              : "The worker has not reported a heartbeat yet."}
          </small>
        </div>
        <div className="stat-card">
          <div>
            Scheduled sources
            <CalendarClock size={15} />
          </div>
          <strong>
            {
              overview.sources.filter((source) => source.schedule !== "Manual")
                .length
            }
          </strong>
          <small>Sources the worker refreshes on a schedule</small>
        </div>
        <div className="stat-card">
          <div>Scheduler</div>
          <strong>{worker.schedulerAt ? when(worker.schedulerAt) : "—"}</strong>
          <small>Last due-source check (every minute)</small>
        </div>
        <div className="stat-card">
          <div>Unread alerts</div>
          <strong>{overview.unreadNotifications}</strong>
          <small>In-app notifications waiting for you</small>
        </div>
      </div>
      {!worker.healthy && (
        <p className="error" role="alert">
          No recent worker heartbeat. Scheduled scans, digests and cleanup will
          not run until the worker process is started.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      <section className="panel opportunities">
        <div className="panel-heading">
          <div>
            <h2>Sources</h2>
            <p>
              Each source records its schedule, next run and most recent result.
              Changing a schedule takes effect at the next aligned UTC instant.
            </p>
          </div>
        </div>
        {overview.sources.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SOURCE</th>
                  <th>STATUS</th>
                  <th>SCHEDULE</th>
                  <th>NEXT RUN</th>
                  <th>LAST RUN</th>
                  <th>RESULT</th>
                </tr>
              </thead>
              <tbody>
                {overview.sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <span className="job-title">{source.company}</span>
                      <small className="cell-sub">
                        {source.provider} · {source.board}
                      </small>
                    </td>
                    <td>
                      <span className="tag">
                        {source.enabled ? "Enabled" : "Disabled"}
                      </span>
                      {source.lastRun?.error && (
                        <small className="cell-sub error">
                          {source.lastRun.error}
                        </small>
                      )}
                    </td>
                    <td>
                      <select
                        aria-label={`Schedule for ${source.company}`}
                        defaultValue={source.schedule}
                        disabled={busy === source.id}
                        onChange={(event) =>
                          void run(
                            source.id,
                            () =>
                              api(`sources/${source.id}/schedule`, "PUT", {
                                schedule: event.target.value as ScanSchedule,
                              }),
                            "Schedule updated.",
                          )
                        }
                      >
                        {scanSchedules.map((schedule) => (
                          <option key={schedule}>{schedule}</option>
                        ))}
                      </select>
                    </td>
                    <td>{when(source.nextRunAt)}</td>
                    <td>
                      {when(source.lastRun?.startedAt)}
                      <small className="cell-sub">
                        {source.lastRun?.trigger === "Schedule"
                          ? "Automatic"
                          : "Manual"}
                        {source.lastCheckedAt
                          ? ` · checked ${when(source.lastCheckedAt)}`
                          : ""}
                      </small>
                    </td>
                    <td>
                      {source.lastRun ? (
                        <>
                          <span className="tag">{source.lastRun.status}</span>
                          <small className="cell-sub">
                            {source.lastRun.discovered} found ·{" "}
                            {source.lastRun.added} new ·{" "}
                            {source.lastRun.updated} changed ·{" "}
                            {source.lastRun.removed} removed ·{" "}
                            {source.lastRun.filtered} filtered
                          </small>
                        </>
                      ) : (
                        <span className="muted">Not scanned</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">
              <CalendarClock size={25} />
            </span>
            <h3>No sources yet</h3>
            <p>
              Add a feed in Discovery or a company watchlist entry to schedule
              automatic refreshes.
            </p>
          </div>
        )}
      </section>
      <section className="panel opportunities">
        <div className="panel-heading">
          <div>
            <h2>Daily digest</h2>
            <p>
              The worker generates the digest during your chosen UTC hour when
              it is enabled. You can also generate one now.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy === "digest"}
            onClick={() =>
              void run(
                "digest",
                async () => {
                  const result = await api<{ digest: Digest }>(
                    "automation/digest",
                    "POST",
                    { narrative: false },
                  );
                  setDigest(result.digest);
                },
                "Digest generated and added to your notifications.",
              )
            }
          >
            <Play size={16} />
            {busy === "digest" ? "Generating…" : "Generate digest now"}
          </Button>
        </div>
        {digest ? (
          <>
            <p>
              {digest.newJobs} new{" "}
              {digest.newJobs === 1 ? "opportunity" : "opportunities"} in the
              last {digest.windowHours} hours. {digest.counts.highPriority}{" "}
              high-priority, {digest.counts.strong} strong,{" "}
              {digest.counts.possible} possible.
            </p>
            {digest.top.length > 0 && (
              <ol className="timeline">
                {digest.top.map((item) => (
                  <li key={item.jobId}>
                    <strong>{item.title}</strong> — {item.company}{" "}
                    <span className="tag">{item.score}</span>{" "}
                    <small className="cell-sub">{item.band}</small>
                  </li>
                ))}
              </ol>
            )}
            {digest.applications.length > 0 && (
              <p className="muted">
                {digest.applications.length} active{" "}
                {digest.applications.length === 1
                  ? "application needs"
                  : "applications need"}{" "}
                attention.
              </p>
            )}
          </>
        ) : (
          <p className="muted">
            No digest generated in this view yet. Generating one is always
            additive: it never sends anything outside your workspace.
          </p>
        )}
      </section>
      <section className="panel opportunities">
        <div className="panel-heading">
          <div>
            <h2>Search history</h2>
            <p>
              Every scan is recorded so connector problems are visible instead
              of silent.
            </p>
          </div>
        </div>
        {overview.runs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SOURCE</th>
                  <th>TRIGGER</th>
                  <th>STARTED</th>
                  <th>DURATION</th>
                  <th>COUNTS</th>
                  <th>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {overview.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{sourceName(run.sourceId)}</td>
                    <td>
                      <span className="tag">{run.trigger}</span>
                    </td>
                    <td>{when(run.startedAt)}</td>
                    <td>
                      {run.durationMs === null
                        ? "—"
                        : `${Math.round(run.durationMs / 1000)}s`}
                    </td>
                    <td>
                      <small className="cell-sub">
                        {run.discovered} found · {run.added} new · {run.updated}{" "}
                        changed · {run.removed} removed · {run.filtered}{" "}
                        filtered
                      </small>
                    </td>
                    <td>
                      <span className="tag">{run.status}</span>
                      {run.error && (
                        <small className="cell-sub error">{run.error}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No scans have run yet.</p>
        )}
      </section>
    </>
  );
}
