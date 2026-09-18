"use client";
import { useEffect, useRef, useState } from "react";
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
  // Loading older history must not restart the poll, so its length is read
  // through a ref instead of becoming an effect dependency.
  const olderCount = useRef(0);
  useEffect(() => {
    olderCount.current = older.length;
  }, [older.length]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function refresh() {
      // A hidden tab keeps its data but stops asking for more until it is
      // looked at again; a failing endpoint is backed off rather than polled.
      if (document.visibilityState === "hidden") {
        if (active && !paused) timer = setTimeout(() => void refresh(), 2000);
        return;
      }
      try {
        const result = await api<Activity[]>(path);
        failures = 0;
        if (active) {
          setEvents(result);
          setError("");
          if (!olderCount.current) setHasMore(result.length === 100);
        }
      } catch (error) {
        failures++;
        if (active) setError((error as Error).message);
      }
      const delay = Math.min(2000 * 2 ** Math.min(failures, 5), 60_000);
      if (active && !paused) timer = setTimeout(() => void refresh(), delay);
    }
    function onVisible() {
      if (document.visibilityState === "visible" && active && !paused) {
        clearTimeout(timer);
        void refresh();
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, paused]);
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
