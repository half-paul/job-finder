"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Plus, Trash2 } from "lucide-react";
import {
  atsProviders,
  scanSchedules,
  watchlistPriorities,
  type WatchlistPriority,
} from "@jobfinder/shared";
import type { watchlist } from "../lib/automation";
import { api } from "./client";
import { Button } from "./ui/button";

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

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">COMPANIES TO WATCH</span>
          <h1>Keep an eye on the employers that matter.</h1>
          <p>
            Watchlist companies are checked on their own schedule. Add a
            Greenhouse, Lever or Ashby board to scan that employer directly;
            without a board, the entry stays a priority list you control.
          </p>
        </div>
      </div>
      <section className="panel form-panel">
        <div className="panel-heading">
          <div>
            <h2>Add a company</h2>
            <p>
              A board name is only needed when you want the worker to scan that
              employer directly.
            </p>
          </div>
        </div>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const provider = String(data.get("provider") ?? "");
            void run(
              "add",
              () =>
                api("watchlist", "POST", {
                  company: data.get("company"),
                  domain: data.get("domain"),
                  provider: provider === "" ? null : provider,
                  board: data.get("board"),
                  priority: data.get("priority"),
                  notes: data.get("notes"),
                  schedule: data.get("schedule"),
                }),
              "Company added to your watchlist.",
            ).then(() => form.reset());
          }}
        >
          <label>
            Company
            <input name="company" required placeholder="e.g. Example SaaS" />
          </label>
          <label>
            Domain (optional)
            <input name="domain" placeholder="example.com" />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue="Interesting">
              {watchlistPriorities.map((priority) => (
                <option key={priority}>{priority}</option>
              ))}
            </select>
          </label>
          <label>
            Direct scan provider (optional)
            <select name="provider" defaultValue="">
              <option value="">Track only, no direct scan</option>
              {atsProviders.map((provider) => (
                <option key={provider}>{provider}</option>
              ))}
            </select>
          </label>
          <label>
            Board name
            <input name="board" placeholder="Board key or company slug" />
            <small>
              Required only for a direct scan. The worker runs it on the
              schedule below.
            </small>
          </label>
          <label>
            Schedule
            <select name="schedule" defaultValue="Every 4 hours">
              {scanSchedules
                .filter((s) => s !== "Manual")
                .map((schedule) => (
                  <option key={schedule}>{schedule}</option>
                ))}
            </select>
          </label>
          <label>
            Notes
            <input name="notes" placeholder="Why this company matters" />
          </label>
          <div className="form-actions">
            <Button disabled={busy === "add"}>
              <Plus size={17} />
              {busy === "add" ? "Adding…" : "Add company"}
            </Button>
          </div>
        </form>
      </section>
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
              Add the employers you would want to hear from first. A watchlist
              entry with a board key is scanned on your schedule.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
