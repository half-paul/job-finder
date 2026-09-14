"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Radar, Plus } from "lucide-react";
import type { listSources } from "../lib/discovery";
import { Button } from "./ui/button";
import { api } from "./client";

type SourceRow = Awaited<ReturnType<typeof listSources>>[number];

const providers = [
  "Greenhouse",
  "Lever",
  "Ashby",
  "RemoteOK",
  "JSON-LD",
] as const;

export function DiscoveryBoard({ sources }: { sources: SourceRow[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function addSource(form: FormData) {
    setBusy("add");
    setError("");
    try {
      await api("sources", "POST", {
        provider: form.get("provider"),
        board: String(form.get("board") ?? "").trim(),
        company: String(form.get("company") ?? "").trim(),
        sourceUrl: String(form.get("sourceUrl") ?? "").trim() || undefined,
      });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function scan(id: string) {
    setBusy(id);
    setError("");
    try {
      await api(`sources/${id}`, "POST");
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
          <span className="eyebrow">PHASE 2 DISCOVERY</span>
          <h1>Approved sources, imported cleanly.</h1>
          <p>
            Add an official board or an allowlisted JSON-LD page, then run a
            complete scan. Sources are private to your workspace.
          </p>
        </div>
      </div>
      <section className="panel form-panel narrow-form">
        <div className="panel-heading">
          <div>
            <h2>Add a source</h2>
            <p>Only official APIs and explicitly allowlisted pages are used.</p>
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
            <select name="provider" defaultValue="Greenhouse">
              {providers.map((provider) => (
                <option key={provider}>{provider}</option>
              ))}
            </select>
          </label>
          <label>
            Company
            <input name="company" required maxLength={200} />
          </label>
          <label>
            Board / site name
            <input name="board" maxLength={200} placeholder="leverdemo" />
          </label>
          <label>
            JSON-LD page URL
            <input
              name="sourceUrl"
              type="url"
              placeholder="Only allowlisted hosts"
            />
          </label>
          <div className="form-actions">
            <Button disabled={busy === "add"}>
              <Plus size={17} />
              {busy === "add" ? "Adding…" : "Add source"}
            </Button>
          </div>
        </form>
      </section>
      <section className="panel opportunities">
        <div className="panel-heading">
          <div>
            <h2>Your sources</h2>
            <p>
              Scans preserve provenance, update changed listings, and mark
              complete-scan removals.
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
                  <th>IDENTIFIER</th>
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
                      <span className="job-title">{source.company}</span>
                      <span className="job-company">{source.provider}</span>
                    </td>
                    <td>
                      <span>{source.board || source.sourceUrl}</span>
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
                        </small>
                      )}
                    </td>
                    <td>
                      <Button
                        variant="outline"
                        disabled={busy === source.id}
                        onClick={() => void scan(source.id)}
                      >
                        <RefreshCw size={16} />
                        {busy === source.id ? "Scanning…" : "Scan"}
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
            <h3>Start with one trusted board</h3>
            <p>
              Add an official Greenhouse, Lever, or Ashby board. RemoteOK needs
              only a company label, and JSON-LD pages require an allowlisted
              host.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
