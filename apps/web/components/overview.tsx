import Link from "next/link";
import {
  ArrowUpRight,
  Plus,
  Sparkles,
  ArrowRight,
  CircleCheck,
  Circle,
} from "lucide-react";
import { eq } from "drizzle-orm";
import { getDb, profiles, resumes, preferences } from "@jobfinder/db";
import { pageUser } from "../lib/auth";
import { dashboardCounts, listJobs } from "../lib/jobs";
import { JobsBoard } from "./jobs-board";
import { Button } from "./ui/button";
export async function Overview({ view = "overview" }: { view?: string }) {
  const user = await pageUser();
  const db = getDb();
  const [counts, initial, profileRows, resumeRows, preferenceRows] =
    await Promise.all([
      dashboardCounts(user.id),
      listJobs(user.id, new URLSearchParams({ view })),
      db.select().from(profiles).where(eq(profiles.userId, user.id)),
      db
        .select({ id: resumes.id })
        .from(resumes)
        .where(eq(resumes.userId, user.id)),
      db.select().from(preferences).where(eq(preferences.userId, user.id)),
    ]);
  const title =
    view === "archived"
      ? "Set aside, not forgotten."
      : view === "saved"
        ? "A shortlist with purpose."
        : view === "applications"
          ? "Keep your next steps moving."
          : view === "all"
            ? "Every possibility, in perspective."
            : "Your next move, in focus.";
  const ready = [
    Boolean(profileRows[0]?.data.currentRole),
    resumeRows.length > 0,
    Boolean(preferenceRows[0]?.data.targetRoles.length),
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {view === "overview" ? "CAREER INTELLIGENCE" : "YOUR WORKSPACE"}
          </span>
          <h1>{title}</h1>
          <p>
            {view === "overview"
              ? "A considered view of your opportunities and what comes next."
              : view === "archived"
                ? "Hidden from your counts and lists, and never imported again."
                : "Less scattered searching. More meaningful progress."}
          </p>
        </div>
        <Button asChild>
          <Link href="/jobs/new">
            <Plus size={17} />
            Add opportunity
          </Link>
        </Button>
      </div>
      {view === "overview" && (
        <>
          <div className="stats-grid">
            {[
              ["Opportunities", counts.total, "In your workspace"],
              ["New today", counts.newToday, "Discovered today · UTC"],
              ["Saved", counts.saved, "Worth a closer look"],
              ["Active applications", counts.applications, "Your next steps"],
            ].map(([label, value, hint]) => (
              <div className="stat-card" key={label}>
                <div>
                  {label}
                  <ArrowUpRight size={15} />
                </div>
                <strong>{value}</strong>
                <small>{hint}</small>
              </div>
            ))}
          </div>
          <section className="setup-banner">
            <div className="setup-intro">
              <span className="sparkle-mark">
                <Sparkles size={20} />
              </span>
              <div>
                <h2>A better search starts with you.</h2>
                <p>
                  Build the picture of what you bring, and where you want to go.
                </p>
              </div>
            </div>
            <div className="setup-steps">
              {[
                ["Career profile", "/profile"],
                ["Add your resume", "/profile"],
                ["Set your direction", "/preferences"],
              ].map(([label, href], i) => (
                <Link href={href} key={label}>
                  {ready[i] ? <CircleCheck size={16} /> : <Circle size={16} />}{" "}
                  {label}
                  <ArrowRight size={14} />
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
      <JobsBoard initial={initial} view={view === "overview" ? "all" : view} />
    </>
  );
}
