"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Radar, Plus } from "lucide-react";
import type { listSources } from "../lib/discovery";
import { Button } from "./ui/button";
import { api } from "./client";
import { useJobSync } from "./job-sync";
import { globalSourceProviders, isGlobalSource } from "@jobfinder/shared";

type SourceRow = Awaited<ReturnType<typeof listSources>>[number];

const providers = globalSourceProviders;

export function DiscoveryBoard({ sources }: { sources: SourceRow[] }) {
  const router = useRouter();
  const { busy: syncing, activeSourceId, sync } = useJobSync();
  const [provider, setProvider] =
    useState<(typeof providers)[number]>("RemoteOK");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function addSource(form: FormData) {
    setBusy("add");
    setError("");
    try {
      await api("sources", "POST", { provider: form.get("provider") });
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
          <span className="eyebrow">JOB DISCOVERY</span>
          <h1>Discover jobs across companies.</h1>
          <p>
            Choose a feed and sync its available jobs across all employers. Your
            country and keyword preferences decide what is imported, and
            eligible jobs are evaluated after syncing.
          </p>
        </div>
      </div>
      <section className="panel form-panel narrow-form">
        <div className="panel-heading">
          <div>
            <h2>Add a source</h2>
            <p>No company name, board name or search URL is needed.</p>
          </div>
        </div>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void addSource(new FormData(event.currentTarget));
          }}
        >
          <label>
            Provider
            <select
              name="provider"
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as (typeof providers)[number])
              }
            >
              {providers.map((provider) => (
                <option key={provider}>{provider}</option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <Button disabled={busy === "add" || syncing}>
              <Plus size={17} />
              {busy === "add" ? "Adding…" : "Add source"}
            </Button>
          </div>
        </form>
      </section>
      <p className="muted">
        RemoteOK and Jobicy provide remote jobs across employers. Indeed is not
        connected. Greenhouse, Lever and Ashby require individual employer
        boards and are not all-company search feeds.
      </p>
      <section className="panel opportunities">
        <div className="panel-heading">
          <div>
            <h2>Your sources</h2>
            <p>
              Sync enabled feeds for new and changed jobs. Older
              employer-specific sources are excluded from Sync jobs.
            </p>
          </div>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {sources.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SOURCE</th>
                  <th>COVERAGE</th>
                  <th>LAST SCAN</th>
                  <th>RESULT</th>
                  <th>
                    <span className="sr-only">Scan</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sources.map(({ source, lastRun }) => (
                  <tr key={source.id}>
                    <td>
                      <span className="job-title">{source.provider}</span>
                    </td>
                    <td>
                      <span>
                        {isGlobalSource(source.provider)
                          ? "All employers in the feed"
                          : "Employer-specific source (legacy)"}
                      </span>
                      <small className="cell-sub">
                        {source.enabled ? "Enabled" : "Disabled"}
                      </small>
                    </td>
                    <td>
                      <span>
                        {lastRun
                          ? lastRun.startedAt.toLocaleString("en-CA")
                          : "Not scanned"}
                      </span>
                    </td>
                    <td>
                      <span className="tag">{lastRun?.status ?? "Ready"}</span>
                      {lastRun && (
                        <small className="cell-sub">
                          {lastRun.discovered} seen · {lastRun.added} added ·{" "}
                          {lastRun.updated} changed · {lastRun.removed} removed
                          · {lastRun.filtered} filtered
                        </small>
                      )}
                      {lastRun?.error && (
                        <small className="cell-sub error">
                          {lastRun.error}
                        </small>
                      )}
                      {Boolean(lastRun?.warnings.length) && (
                        <details>
                          <summary>Source messages</summary>
                          <ul>
                            {lastRun!.warnings.map((warning, index) => (
                              <li key={index}>{warning}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td>
                      <Button
                        variant="outline"
                        disabled={
                          syncing ||
                          busy !== null ||
                          !source.enabled ||
                          !isGlobalSource(source.provider)
                        }
                        onClick={() => void sync(source)}
                      >
                        <RefreshCw size={16} />
                        {activeSourceId === source.id
                          ? "Scanning…"
                          : isGlobalSource(source.provider)
                            ? "Sync source"
                            : "Not a global feed"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">
              <Radar size={25} />
            </span>
            <h3>Choose a job feed</h3>
            <p>
              Add RemoteOK or Jobicy to discover jobs from multiple employers.
              Add countries in Preferences to focus your results.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
