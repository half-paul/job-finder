"use client";
import { useEffect, useState } from "react";
import { api } from "./client";
import { Button } from "./ui/button";

type Activity = {
  id: string;
  createdAt: string;
  actor: string;
  stage: string;
  level: string;
  message: string;
};
export function ActivityFeed({ candidateId }: { candidateId?: string }) {
  const [events, setEvents] = useState<Activity[]>([]);
  const [older, setOlder] = useState<Activity[]>([]);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const path = `activity${candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ""}`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<Activity[]>(path);
        if (active) {
          setEvents(result);
          setError("");
          if (!older.length) setHasMore(result.length === 100);
        }
      } catch (error) {
        if (active) setError((error as Error).message);
      }
      if (active && !paused) timer = setTimeout(() => void refresh(), 2000);
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path, paused, older.length]);
  const all = [
    ...new Map(
      [...events, ...older].map((event) => [event.id, event]),
    ).values(),
  ];
  return (
    <section className="panel opportunities activity-panel">
      <div className="panel-heading">
        <div>
          <h2>Live activity</h2>
          <p>
            {paused ? "Updates paused" : "Updates every 2 seconds"} · Worker and
            application actions
          </p>
        </div>
        <Button variant="outline" onClick={() => setPaused(!paused)}>
          {paused ? "Resume updates" : "Pause updates"}
        </Button>
      </div>
      {error && (
        <p className="error" role="alert">
          Activity could not refresh: {error}
        </p>
      )}
      <div
        className="activity-log"
        aria-label="Worker and application activity"
      >
        {all.length ? (
          <ol className="timeline">
            {all.map((event) => (
              <li
                key={event.id}
                className={event.level === "error" ? "error" : undefined}
              >
                <small className="cell-sub">
                  <time dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleString()}
                  </time>{" "}
                  · {event.actor} · {event.stage}
                </small>
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">
            No activity recorded yet. Add a company or start a scan to see its
            actions here.
          </p>
        )}
      </div>
      {hasMore && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              const last = all.at(-1);
              const result = await api<Activity[]>(
                `${path}${candidateId ? "&" : "?"}before=${encodeURIComponent(last!.createdAt)}`,
              );
              setOlder([...all, ...result]);
              setHasMore(result.length === 100);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? "Loading…" : "Load older activity"}
        </Button>
      )}
    </section>
  );
}
