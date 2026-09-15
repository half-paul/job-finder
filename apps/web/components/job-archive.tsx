"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Undo2 } from "lucide-react";
import { Button } from "./ui/button";
import { api } from "./client";
export function JobArchive({
  id,
  archived,
}: {
  id: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function submit(next: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`jobs/${id}/archive`, "PUT", { archived: next });
      setMessage(
        next
          ? "Archived. This opportunity is out of your counts and lists and will not be imported again."
          : "Restored to your workspace.",
      );
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="archive-control">
      <p className="muted">
        {archived
          ? "This opportunity is archived. It is excluded from counts, lists and automatic evaluation, and a future sync will not import it again."
          : "Archiving hides this opportunity from your counts, lists and automatic evaluation. It stays saved here and is never imported again."}
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void submit(!archived)}
      >
        {archived ? <Undo2 size={16} /> : <Archive size={16} />}
        {busy
          ? archived
            ? "Restoring…"
            : "Archiving…"
          : archived
            ? "Restore opportunity"
            : "Archive opportunity"}
      </Button>
      {archived && (
        <Link className="back-link" href="/archived">
          View archived opportunities
        </Link>
      )}
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
    </div>
  );
}
