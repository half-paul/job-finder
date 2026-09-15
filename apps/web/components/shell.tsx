"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  BriefcaseBusiness,
  Bookmark,
  Layers3,
  Archive,
  UserRound,
  SlidersHorizontal,
  Moon,
  Sun,
  LogOut,
  ArrowUpRight,
  Compass,
  Radar,
  Menu,
  BookmarkCheck,
  Workflow,
} from "lucide-react";
import { api } from "./client";
import { JobSyncProvider, JobSyncFeedback, SyncJobsButton } from "./job-sync";
import { NotificationsBell } from "./notifications-bell";
const nav = [
  ["/", "Overview", LayoutDashboard],
  ["/jobs", "All opportunities", BriefcaseBusiness],
  ["/saved", "Saved", Bookmark],
  ["/applications", "Applications", Layers3],
  ["/archived", "Archived", Archive],
  ["/discovery", "Discovery", Radar],
  ["/watchlist", "Watchlist", BookmarkCheck],
  ["/automation", "Automation", Workflow],
  ["/profile", "Career profile", UserRound],
  ["/preferences", "Preferences", SlidersHorizontal],
] as const;
export function Shell({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  function toggleTheme() {
    const next = document.documentElement.dataset.theme !== "dark";
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
  }
  return (
    <JobSyncProvider>
      <div className="workspace">
        <aside className={open ? "sidebar is-open" : "sidebar"}>
          <Link className="brand" href="/">
            <span className="brand-mark">
              <Compass size={23} />
            </span>
            JobFinder<span className="brand-ai">AI</span>
          </Link>
          <div className="workspace-label">YOUR CAREER WORKSPACE</div>
          <nav aria-label="Main navigation">
            {nav.map(([href, label, Icon]) => (
              <Link
                onClick={() => setOpen(false)}
                className={`${path === href || (href === "/jobs" && path.startsWith("/jobs/")) ? "nav-link active" : "nav-link"}${href === "/profile" ? " nav-divider" : ""}`}
                href={href}
                key={href}
              >
                <Icon size={18} />
                {label}
              </Link>
            ))}
          </nav>
          <div className="sidebar-note">
            <span className="small-label">A MORE INTENTIONAL SEARCH</span>
            <p>
              Your experience.
              <br />
              Your direction.
              <br />
              Your next chapter.
            </p>
            <Link href="/profile">
              Shape your profile <ArrowUpRight size={15} />
            </Link>
          </div>
          <div className="sidebar-user">
            <span className="avatar">{name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{name}</strong>
              <span>Personal workspace</span>
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="Toggle navigation"
              onClick={() => setOpen(!open)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">
              Workspace <span>/</span>{" "}
              <strong>
                {nav.find(([href]) => href === path)?.[1] ?? "Opportunity"}
              </strong>
            </span>
            <div className="topbar-actions">
              <SyncJobsButton />
              <NotificationsBell />
              <span className="private-badge">
                <i />
                Private workspace
              </span>
              <button
                className="icon-button"
                aria-label="Toggle color theme"
                onClick={toggleTheme}
              >
                {dark ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={async () => {
                  try {
                    await api("auth/logout", "POST");
                    router.push("/login");
                    router.refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <LogOut size={18} />
              </button>
            </div>
          </header>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <main className="content">
            <JobSyncFeedback />
            {children}
          </main>
          <footer className="footer">
            Built around your next move.<span>JobFinder AI · Foundation</span>
          </footer>
        </div>
      </div>
    </JobSyncProvider>
  );
}
