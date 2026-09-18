"use client";
import { useEffect, useState } from "react";
import type { listCompanies, workerHealth } from "@jobfinder/automation";
import {
  candidateStatusLabel,
  strategyLabel,
  type CandidateStatus,
  type CrawlStrategy,
} from "@jobfinder/shared";
import { CompanyIntake } from "./company-intake";
import { ActivityFeed } from "./activity-feed";
import { api } from "./client";
import { Button } from "./ui/button";

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
    async function refresh() {
      try {
        const result = await api<Overview>("companies");
        if (active) {
          setOverview(result);
          setError("");
        }
      } catch (error) {
        if (active) setError((error as Error).message);
      }
      if (active) timer = setTimeout(() => void refresh(), 2000);
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
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
          <h1>Your companies. Discovery handled.</h1>
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
              {
                companies.filter((row) =>
                  ["Pending", "Resolving"].includes(row.candidate.status),
                ).length
              }{" "}
              waiting or discovering · Updates every 2 seconds
            </p>
          </div>
        </div>
        {!overview ? (
          <p>Loading companies…</p>
        ) : !companies.length ? (
          <p className="muted">No companies imported yet.</p>
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
                      <strong>{candidate.name}</strong>
                      <small className="cell-sub">{candidate.domain}</small>
                      {candidate.careersUrl && (
                        <a
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
                        <small className="cell-sub error">
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
                            <small className="cell-sub error">
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
                        <Button
                          variant="outline"
                          disabled={
                            busy === candidate.id ||
                            ["Pending", "Resolving"].includes(candidate.status)
                          }
                          onClick={() => void action(candidate.id, "POST")}
                        >
                          Retry discovery
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy === candidate.id}
                          onClick={() => void action(candidate.id, "DELETE")}
                        >
                          Remove
                        </Button>
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
