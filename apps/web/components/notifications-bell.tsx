"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { api } from "./client";

// Polls the unread count only; the full alert list lives on the Notifications
// page so a workspace render never loads the whole history.
export function NotificationsBell() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows =
          await api<{ notification: { readAt: string | null } }[]>(
            "notifications",
          );
        if (!cancelled)
          setCount(rows.filter((row) => !row.notification.readAt).length);
      } catch {
        // A missing count must never break the workspace shell.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <Link className="icon-button bell" href="/notifications">
      <Bell size={18} />
      <span className="sr-only">
        {count > 0 ? `${count} unread notifications` : "Notifications"}
      </span>
      {count > 0 && (
        <span className="bell-count" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
