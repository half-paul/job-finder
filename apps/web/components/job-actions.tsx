"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { statusValues } from "@jobfinder/shared";
import { Button } from "./ui/button";
import { api } from "./client";
export function JobActions({
  id,
  status,
  notes,
}: {
  id: string;
  status: string;
  notes: string;
}) {
  const [state, setState] = useState(status);
  const [text, setText] = useState(notes);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        setMessage("");
        try {
          await api(`jobs/${id}/status`, "PUT", { status: state, notes: text });
          setMessage("Progress updated.");
          router.refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Your progress
        <select value={state} onChange={(e) => setState(e.target.value)}>
          {statusValues.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        Private notes
        <textarea
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={10000}
          placeholder="What stands out? What is your next step?"
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      <Button disabled={busy}>{busy ? "Updating…" : "Update progress"}</Button>
    </form>
  );
}
