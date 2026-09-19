"use client";
import { useEffect, useState } from "react";
import type { listCompanies, workerHealth } from "@jobfinder/automation";
import {
  candidateStatusLabel,
  isCandidateInFlight as inFlight,
  strategyLabel,
  type CandidateStatus,
  type CrawlStrategy,
} from "@jobfinder/shared";
import { CompanyIntake } from "./company-intake";
import { ActivityFeed } from "./activity-feed";
import { api } from "./client";
import { Building2, RefreshCw, Trash2 } from "lucide-react";

type Overview = {
  companies: Awaited<ReturnType<typeof listCompanies>>;
  worker: Awaited<ReturnType<typeof workerHealth>>;
};
export function CompanyBoard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function refresh() {
      // Same contract as the activity feed: a hidden tab stops asking, and a
      // failing endpoint is backed off instead of polled every two seconds.
      if (document.visibilityState === "hidden") {
        if (active) timer = setTimeout(() => void refresh(), 2000);
        return;
      }
      try {
        const result = await api<Overview>("companies");
        failures = 0;
        if (active) {
          setOverview(result);
          setError("");
        }
      } catch (error) {
        failures++;
        if (active) setError((error as Error).message);
      }
      const delay = Math.min(2000 * 2 ** Math.min(failures, 5), 60_000);
      if (active) timer = setTimeout(() => void refresh(), delay);
    }
    function onVisible() {
      if (document.visibilityState === "visible" && active) {
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
  }, [revision]);
  async function action(id: string, method: "POST" | "DELETE") {
    setBusy(id);
    try {
      await api(`companies/${id}`, method);
      setRevision((value) => value + 1);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const companies = overview?.companies ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">COMPANIES</span>
          <h1>The employers you are tracking.</h1>
          <p>
            Add one company or import a list of organizations and domains.
            Follow discovery and scanning below.
          </p>
        </div>
      </div>
      <CompanyIntake onImported={() => setRevision((value) => value + 1)} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {overview && !overview.worker.healthy && (
        <p className="error" role="status">
          Worker is not running. Companies are saved and will be processed when
          it starts.
        </p>
      )}
      <section className="panel opportunities">
        <div className="panel-heading">
          <div>
            <h2>Company discovery</h2>
            <p>
              {companies.length} companies ·{" "}
              {companies.filter((row) => inFlight(row.candidate.status)).length}{" "}
              waiting or discovering · Updates every 2 seconds
            </p>
          </div>
        </div>
        {!overview ? (
          <p className="panel-message">Loading companies…</p>
        ) : !companies.length ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Building2 size={25} />
            </span>
            <h3>No companies yet</h3>
            <p>
              Add one company above, or paste a list of organizations and
              domains. Discovery finds each careers page and starts scanning.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>COMPANY</th>
                  <th>DISCOVERY</th>
                  <th>SCAN PROGRESS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {companies.map(({ candidate, source, lastRun }) => (
                  <tr key={candidate.id}>
                    <td>
                      <span className="job-title">{candidate.name}</span>
                      <small className="cell-sub">{candidate.domain}</small>
                      {candidate.careersUrl && (
                        <a
                          className="cell-link"
                          href={candidate.careersUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Careers page
                        </a>
                      )}
                    </td>
                    <td>
                      <span className="tag">
                        {candidateStatusLabel[
                          candidate.status as CandidateStatus
                        ] ?? candidate.status}
                      </span>
                      <small className="cell-sub">
                        {strategyLabel[candidate.strategy as CrawlStrategy] ??
                          candidate.strategy}
                      </small>
                      {candidate.error && (
                        <small className="cell-sub is-error">
                          {candidate.error}
                        </small>
                      )}
                    </td>
                    <td>
                      {lastRun ? (
                        <>
                          <span className="tag">
                            {lastRun.status === "Running"
                              ? "Scanning…"
                              : lastRun.status}
                          </span>
                          <small className="cell-sub">
                            {lastRun.discovered} found · {lastRun.added} added ·{" "}
                            {lastRun.updated} changed · {lastRun.filtered}{" "}
                            filtered
                          </small>
                          {lastRun.error && (
                            <small className="cell-sub is-error">
                              {lastRun.error}
                            </small>
                          )}
                        </>
                      ) : source ? (
                        "First scan queued"
                      ) : (
                        "Waiting for discovery"
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="icon-button-labeled"
                          aria-label={`Retry discovery for ${candidate.name}`}
                          disabled={
                            busy === candidate.id || inFlight(candidate.status)
                          }
                          onClick={() => void action(candidate.id, "POST")}
                        >
                          <RefreshCw size={16} />
                          {busy === candidate.id ? "Working…" : "Retry"}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove ${candidate.name}`}
                          disabled={busy === candidate.id}
                          onClick={() => void action(candidate.id, "DELETE")}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ActivityFeed />
    </>
  );
}
