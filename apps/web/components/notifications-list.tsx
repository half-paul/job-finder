"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellRing, CheckCheck } from "lucide-react";
import type { alerts } from "../lib/automation";
import { api } from "./client";
import { Button } from "./ui/button";

type Row = Awaited<ReturnType<typeof alerts.list>>[number];

// In-app alert history. Alerts are opt-in records; nothing here sends email,
// SMS or push messages, and marking one read never changes a job.
export function NotificationsList({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function mark(key: string, body: unknown) {
    setBusy(key);
    setError("");
    try {
      await api("notifications/mark", "POST", body);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const unread = rows.filter((row) => !row.notification.readAt).length;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ALERTS</span>
          <h1>What is worth your attention.</h1>
          <p>
            Alerts appear when an evaluated match reaches your alert score, and
            when a digest is generated. They are stored here only.
          </p>
        </div>
        {unread > 0 && (
          <Button
            variant="outline"
            disabled={busy === "all"}
            onClick={() => void mark("all", { all: true })}
          >
            <CheckCheck size={16} />
            {busy === "all" ? "Marking…" : `Mark all ${unread} as read`}
          </Button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel opportunities">
        <div className="panel-heading">
          <div>
            <h2>Notifications</h2>
            <p>
              {rows.length} {rows.length === 1 ? "record" : "records"} ·{" "}
              {unread} unread
            </p>
          </div>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>WHEN</th>
                  <th>TYPE</th>
                  <th>ALERT</th>
                  <th>SCORE</th>
                  <th>
                    <span className="sr-only">Mark read</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ notification, job }) => (
                  <tr key={notification.id}>
                    <td>
                      {new Date(notification.createdAt).toLocaleString("en-CA")}
                      {!notification.readAt && (
                        <small className="cell-sub">Unread</small>
                      )}
                    </td>
                    <td>
                      <span className="tag">{notification.kind}</span>
                    </td>
                    <td>
                      <span className="job-title">{notification.title}</span>
                      {notification.body && (
                        <small className="cell-sub">{notification.body}</small>
                      )}
                      {job && (
                        <Link href={`/jobs/${job.id}`}>Open opportunity</Link>
                      )}
                    </td>
                    <td>
                      {notification.score === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <strong>{notification.score}</strong>
                      )}
                    </td>
                    <td className="row-actions">
                      {!notification.readAt && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Mark ${notification.title} as read`}
                          disabled={busy === notification.id}
                          onClick={() =>
                            void mark(notification.id, { id: notification.id })
                          }
                        >
                          <CheckCheck size={16} />
                        </button>
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
              <BellRing size={25} />
            </span>
            <h3>No alerts yet</h3>
            <p>
              Enable alerts in Preferences, then evaluate opportunities. An
              alert appears here when a match reaches your alert score.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
