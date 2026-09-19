"use client";

import Link from "next/link";
import { createContext, useContext, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { listSources, scanSource } from "../lib/discovery";
import type { evaluateSyncedJobs } from "../lib/matching";
import { isGlobalSource } from "@jobfinder/shared";
import { api } from "./client";
import { Button } from "./ui/button";

type Source = Awaited<ReturnType<typeof listSources>>[number]["source"];
type Run = Awaited<ReturnType<typeof scanSource>>;
type SyncContext = {
  busy: boolean;
  activeSourceId: string | null;
  message: string;
  issues: string[];
  sync: (source?: Pick<Source, "id" | "company" | "provider">) => Promise<void>;
};
const JobSyncContext = createContext<SyncContext | null>(null);

export function useJobSync() {
  const context = useContext(JobSyncContext);
  if (!context) throw new Error("Job sync requires a workspace.");
  return context;
}

export function JobSyncProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<string[]>([]);

  async function sync(source?: Pick<Source, "id" | "company" | "provider">) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("Preparing job sync…");
    setIssues([]);
    try {
      const selected = source
        ? [source]
        : (await api<{ source: Source }[]>("sources"))
            .filter(
              ({ source }) => source.enabled && isGlobalSource(source.provider),
            )
            .map(({ source }) => source);
      if (!selected.length) {
        setMessage(
          "No enabled global feeds. Add one in Discovery to start syncing jobs.",
        );
        return;
      }
      let succeeded = 0;
      let partial = 0;
      let failed = 0;
      let added = 0;
      let updated = 0;
      let removed = 0;
      let filtered = 0;
      const problems: string[] = [];
      const runIds: string[] = [];
      // One request per source keeps progress visible and lets other sources
      // continue when a provider fails. The workspace layout survives navigation.
      for (const [index, item] of selected.entries()) {
        setActiveSourceId(item.id);
        setMessage(
          `${item.provider === "JSON-LD" ? "Crawling" : "Syncing"} ${item.company} (${index + 1} of ${selected.length})… Keep this tab open.`,
        );
        try {
          const run = await api<Run>(`sources/${item.id}`, "POST");
          if (run.status === "Succeeded") succeeded++;
          else if (run.status === "Partial") partial++;
          else failed++;
          if (["Succeeded", "Partial"].includes(run.status))
            runIds.push(run.id);
          added += run.added;
          updated += run.updated;
          removed += run.removed;
          filtered += run.filtered ?? 0;
          if (run.error) problems.push(`${item.company}: ${run.error}`);
          for (const warning of run.warnings) {
            problems.push(`${item.company}: ${warning}`);
          }
        } catch (error) {
          failed++;
          problems.push(
            `${item.company}: ${error instanceof Error ? error.message : "Sync failed."}`,
          );
        }
        setIssues([...problems]);
        router.refresh();
      }
      const summary = `Sync finished: ${succeeded} succeeded, ${partial} partial, ${failed} failed. ${added} added · ${updated} changed · ${removed} removed${filtered ? ` · ${filtered} skipped by your keyword filters` : ""}.`;
      setActiveSourceId(null);
      if (runIds.length) {
        setMessage(
          `${summary} Evaluating eligible jobs within your preference limit… Keep this tab open.`,
        );
        try {
          const evaluation = await api<
            Awaited<ReturnType<typeof evaluateSyncedJobs>>
          >("jobs/evaluation-batch", "POST", { runIds });
          problems.push(
            ...evaluation.errors.map((error) => `Evaluation: ${error}`),
          );
          setMessage(
            `${summary} ${evaluation.enabled ? `Evaluation: ${evaluation.evaluated} evaluated, ${evaluation.failed} failed (maximum ${evaluation.limit} per sync).` : "Automatic evaluation is turned off in Preferences."}`,
          );
        } catch (error) {
          problems.push(
            `Evaluation: ${error instanceof Error ? error.message : "Could not start evaluation."}`,
          );
          setMessage(`${summary} Automatic evaluation could not complete.`);
        }
        setIssues([...problems]);
        router.refresh();
      } else setMessage(summary);
    } catch (error) {
      setMessage("Could not start job sync.");
      setIssues([error instanceof Error ? error.message : "Please try again."]);
    } finally {
      running.current = false;
      setBusy(false);
      setActiveSourceId(null);
    }
  }

  return (
    <JobSyncContext.Provider
      value={{ busy, activeSourceId, message, issues, sync }}
    >
      {children}
    </JobSyncContext.Provider>
  );
}

export function JobSyncFeedback() {
  const { message, issues } = useJobSync();
  return (
    <>
      {message && (
        <section className="panel sync-feedback" aria-label="Job sync progress">
          <p role="status">{message}</p>
          {issues.length > 0 && (
            <details>
              <summary>View {issues.length} source messages</summary>
              <ul>
                {issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            </details>
          )}
          <Link href="/discovery">Manage sources and view scan results</Link>
        </section>
      )}
    </>
  );
}

export function SyncJobsButton() {
  const { busy, sync } = useJobSync();
  return (
    <Button variant="outline" disabled={busy} onClick={() => void sync()}>
      <RefreshCw size={16} />
      {busy ? "Syncing…" : "Sync jobs"}
    </Button>
  );
}
