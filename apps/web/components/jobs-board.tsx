"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Archive,
  BriefcaseBusiness,
  Search,
  SlidersHorizontal,
  Plus,
  Bookmark,
  ArrowRight,
  Undo2,
} from "lucide-react";
import { jobsPageLimit } from "@jobfinder/shared";
import type { listJobs } from "../lib/jobs";
import { Button } from "./ui/button";
import { api } from "./client";
import { count, salary } from "../lib/display";
type Result = Awaited<ReturnType<typeof listJobs>>;
export function JobsBoard({
  initial,
  view = "all",
}: {
  initial: Result;
  view?: string;
}) {
  const router = useRouter();
  const archivedView = view === "archived";
  const [data, setData] = useState(initial);
  const [query, setQuery] = useState("");
  const [work, setWork] = useState("");
  const [score, setScore] = useState("0");
  const [sort, setSort] = useState("best");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  async function setArchived(id: string, archived: boolean) {
    setBusyId(id);
    setError("");
    setMessage("");
    try {
      await api(`jobs/${id}/archive`, "PUT", { archived });
      setMessage(
        archived
          ? "Opportunity archived. It is hidden from your counts and lists."
          : "Opportunity restored to your workspace.",
      );
      setRefresh((value) => value + 1);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: query,
          work,
          score,
          sort,
          view,
          page: String(page),
        });
        const res = await fetch(`/api/jobs?${params}`, {
          signal: abort.signal,
        });
        if (!res.ok) throw new Error("Could not load opportunities.");
        const next: Result = await res.json();
        setData(next);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, work, score, sort, view, page, initial, refresh]);
  const filtered = Boolean(query || work || score !== "0");
  const noun = data.total === 1 ? "opportunity" : "opportunities";
  const first = (data.page - 1) * jobsPageLimit + 1;
  const last = (data.page - 1) * jobsPageLimit + data.items.length;
  const countLabel = data.items.length
    ? `Showing ${count(first)}\u2013${count(last)} of ${count(data.total)} ${noun}`
    : `${count(data.total)} ${noun}`;
  const emptyHeading = filtered
    ? archivedView
      ? "No archived opportunities match these filters"
      : "No opportunities match these filters"
    : archivedView
      ? "Nothing archived yet"
      : view === "saved"
        ? "Make room for the possibilities"
        : view === "applications"
          ? "Your next chapter starts with a first step"
          : "A clear view of what comes next";
  return (
    <section className="panel opportunities">
      <div className="panel-heading">
        <div>
          <h2>
            {archivedView
              ? "Archived opportunities"
              : view === "saved"
                ? "Your shortlist"
                : view === "applications"
                  ? "Application pipeline"
                  : "Your opportunities"}
          </h2>
          <p>
            {archivedView
              ? "Set aside, out of your counts, and never imported again."
              : "Keep the right possibilities in view."}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/jobs/new">
            <Plus size={16} />
            Add opportunity
          </Link>
        </Button>
      </div>
      <div className="filterbar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Search opportunities"
            placeholder="Search title, company or location…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <select
          aria-label="Work arrangement"
          value={work}
          onChange={(e) => {
            setWork(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All locations</option>
          <option>Remote</option>
          <option>Hybrid</option>
          <option>On-site</option>
        </select>
        <select
          aria-label="Minimum match score"
          value={score}
          onChange={(e) => {
            setScore(e.target.value);
            setPage(1);
          }}
        >
          <option value="0">Any match score</option>
          <option value="85">85+ strong matches</option>
          <option value="93">93+ excellent matches</option>
        </select>
        <SlidersHorizontal size={17} className="filter-icon" />
      </div>
      <div className="results-meta">
        <span aria-live="polite">{loading ? "Updating…" : countLabel}</span>
        <label>
          Sort by{" "}
          <select
            aria-label="Sort opportunities"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
          >
            <option value="best">Best match</option>
            <option value="newest">Newest discovered</option>
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      {data.items.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>OPPORTUNITY</th>
                <th>MATCH</th>
                <th>LOCATION</th>
                <th>COMPENSATION</th>
                <th>STATUS</th>
                <th>
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(({ job, match, state }) => (
                <tr key={job.id}>
                  <td>
                    <Link className="job-title" href={`/jobs/${job.id}`}>
                      {job.title}
                    </Link>
                    <span className="job-company">
                      {job.company}
                      <span>·</span>
                      {job.source}
                    </span>
                  </td>
                  <td>
                    {match ? (
                      <span className="score">
                        {match.overallScore}
                        <small>
                          Q {match.qualificationScore} · I {match.interestScore}
                        </small>
                      </span>
                    ) : (
                      <span className="unscored">Not evaluated</span>
                    )}
                  </td>
                  <td>
                    <span>{job.location || "Not listed"}</span>
                    <small className="cell-sub">{job.workType}</small>
                  </td>
                  <td>{salary(job)}</td>
                  <td>
                    <span className="tag">{state || "Discovered"}</span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Link
                        className="icon-button"
                        aria-label={`View ${job.title}`}
                        href={`/jobs/${job.id}`}
                      >
                        <ArrowUpRight size={17} />
                      </Link>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busyId === job.id}
                        aria-label={
                          archivedView
                            ? `Restore ${job.title}`
                            : `Archive ${job.title}`
                        }
                        onClick={() => void setArchived(job.id, !archivedView)}
                      >
                        {archivedView ? (
                          <Undo2 size={17} />
                        ) : (
                          <Archive size={17} />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <span className="empty-icon">
            {archivedView ? (
              <Archive size={25} />
            ) : view === "saved" ? (
              <Bookmark size={25} />
            ) : (
              <BriefcaseBusiness size={25} />
            )}
          </span>
          <h3>{emptyHeading}</h3>
          <p>
            {archivedView
              ? "Archive an opportunity from this list or its detail page. Archived opportunities stay out of your counts and lists, and future syncs will not import them again."
              : view === "saved"
                ? "Save opportunities from a job's detail page to build your shortlist."
                : view === "applications"
                  ? "Update an opportunity to Applied or Interviewing to track it here."
                  : "Add an opportunity you’re considering. Your private workspace will keep the details and your next steps together."}
          </p>
          <Button asChild variant="outline">
            <Link href={view === "all" ? "/jobs/new" : "/jobs"}>
              {archivedView
                ? "Browse opportunities"
                : view === "all"
                  ? "Add your first opportunity"
                  : "Explore opportunities"}
              <ArrowRight size={16} />
            </Link>
          </Button>
        </div>
      )}
      <div className="table-footer">
        <span>
          {archivedView
            ? "Archived opportunities are excluded from counts, lists and automatic evaluation until you restore them."
            : "Filter by match score, work arrangement or keyword to focus your list."}
        </span>
        <div>
          <button
            disabled={page === 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>{page}</span>
          <button
            disabled={!data.hasMore || loading}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
