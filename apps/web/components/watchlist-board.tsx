"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Trash2, RefreshCw } from "lucide-react";
import { watchlistPriorities, type WatchlistPriority } from "@jobfinder/shared";
import type { watchlist } from "../lib/automation";
import Link from "next/link";
import { api } from "./client";
import { Button } from "./ui/button";
import { ActivityFeed } from "./activity-feed";

type Entry = Awaited<ReturnType<typeof watchlist.list>>[number];

/**
 * Watchlist entries carry the user's own priority. An entry that names a
 * supported ATS board also owns the employer source the worker scans on its
 * schedule, so the company is checked even when it never appears on a feed.
 */
export function WatchlistBoard({ entries }: { entries: Entry[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [scanningAll, setScanningAll] = useState(false);
  const [scanningSource, setScanningSource] = useState<Set<string>>(new Set());

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

  const isScanning = (entry: Entry) =>
    busy === entry.id ||
    (entry.source ? scanningSource.has(entry.source.id) : false);

  async function handleScanSource(sourceId: string, refresh = true) {
    setScanningSource((prev) => new Set(prev).add(sourceId));
    try {
      await api(`sources/${sourceId}`, "POST");
      if (refresh) router.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setScanningSource((prev) => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  }

  async function handleScanAll() {
    const sourceIds = entries
      .map((entry) => entry.source?.id)
      .filter((id): id is string => id !== undefined);
    if (sourceIds.length === 0) {
      setError("No companies with direct scan available to scan.");
      return;
    }
    setScanningAll(true);
    try {
      for (const sourceId of sourceIds) {
        await handleScanSource(sourceId, false);
      }
      // One refetch for the batch: refreshing per source re-ran the whole
      // page's server queries once per company.
      router.refresh();
    } finally {
      setScanningAll(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">COMPANIES TO WATCH</span>
          <h1>Keep an eye on the employers that matter.</h1>
          <p>
            Scan the employers you are tracking, or{" "}
            <Link className="inline-link" href="/companies">
              add and import companies
            </Link>{" "}
            to have their careers pages discovered.
          </p>
        </div>
      </div>
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
            <h2>Your watchlist</h2>
            <p>
              {entries.length} {entries.length === 1 ? "company" : "companies"}.
              Remove an entry to stop scanning it directly.
            </p>
          </div>
          {entries.length > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleScanAll()}
              disabled={scanningAll}
            >
              {scanningAll ? "Scanning all…" : "Scan all"}
            </Button>
          )}
        </div>
        {entries.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>COMPANY</th>
                  <th>PRIORITY</th>
                  <th>DIRECT SCAN</th>
                  <th>NEXT RUN</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <span className="job-title">{entry.company}</span>
                      {entry.domain && (
                        <small className="cell-sub">{entry.domain}</small>
                      )}
                      {entry.notes && (
                        <small className="cell-sub">{entry.notes}</small>
                      )}
                    </td>
                    <td>
                      <select
                        aria-label={`Priority for ${entry.company}`}
                        defaultValue={entry.priority}
                        disabled={busy === entry.id}
                        onChange={(event) =>
                          void run(
                            entry.id,
                            () =>
                              api(`watchlist/${entry.id}`, "PUT", {
                                priority: event.target
                                  .value as WatchlistPriority,
                              }),
                            "Priority updated.",
                          )
                        }
                      >
                        {watchlistPriorities.map((priority) => (
                          <option key={priority}>{priority}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {entry.source ? (
                        <>
                          <span className="tag">{entry.source.provider}</span>
                          <small className="cell-sub">
                            {entry.source.board} ·{" "}
                            {entry.source.enabled ? "enabled" : "disabled"}
                          </small>
                        </>
                      ) : (
                        <span className="muted">No direct scan</span>
                      )}
                    </td>
                    <td>
                      {entry.source?.nextRunAt ? (
                        new Date(entry.source.nextRunAt).toLocaleString("en-CA")
                      ) : (
                        <span className="muted">Not scheduled</span>
                      )}
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="icon-button-labeled"
                        aria-label={`Scan ${entry.company} now`}
                        disabled={!entry.source || isScanning(entry)}
                        onClick={() => {
                          if (entry.source?.id)
                            void handleScanSource(entry.source.id);
                        }}
                      >
                        <RefreshCw size={16} />
                        {isScanning(entry) ? "Scanning…" : "Scan"}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${entry.company} from your watchlist`}
                        disabled={busy === entry.id}
                        onClick={() =>
                          void run(
                            entry.id,
                            () => api(`watchlist/${entry.id}`, "DELETE"),
                            "Company removed and its direct scan disabled.",
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">
              <Bookmark size={25} />
            </span>
            <h3>No companies yet</h3>
            <p>
              Add the employers you would want to hear from first. Website and
              careers discovery run automatically.
            </p>
          </div>
        )}
      </section>
      <ActivityFeed />
    </>
  );
}
