"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "./client";
import { Button } from "./ui/button";

type ImportResult = {
  imported: number;
  duplicates: number;
  rejected: { line: number; reason: string }[];
};
export function CompanyIntake({ onImported }: { onImported?: () => void }) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  async function submit(body: unknown, form: HTMLFormElement) {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const result = await api<ImportResult>("companies", "POST", body);
      setResult(result);
      if (result.imported) {
        onImported?.();
        if (mode === "single") form.reset();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel form-panel">
      <div className="panel-heading">
        <div>
          <h2>
            {mode === "single"
              ? "Add a company"
              : "Import organizations in bulk"}
          </h2>
          <p>
            Provide a name and website. We find the careers page and job API,
            then use AI extraction if needed.
          </p>
        </div>
      </div>
      <div className="form-actions company-tabs">
        <Button
          type="button"
          variant={mode === "single" ? "default" : "outline"}
          onClick={() => setMode("single")}
        >
          One company
        </Button>
        <Button
          type="button"
          variant={mode === "bulk" ? "default" : "outline"}
          onClick={() => setMode("bulk")}
        >
          Bulk import
        </Button>
      </div>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void submit(
            mode === "single"
              ? { name: data.get("name"), url: data.get("url") }
              : { text },
            form,
          );
        }}
      >
        {mode === "single" ? (
          <>
            <label>
              Company name
              <input name="name" required maxLength={200} placeholder="Acme" />
            </label>
            <label>
              Website or careers URL
              <input
                name="url"
                required
                maxLength={2000}
                placeholder="acme.com or https://acme.com/careers"
              />
            </label>
          </>
        ) : (
          <>
            <label className="full-width">
              CSV or text file
              <input
                type="file"
                accept=".csv,.txt,.tsv,text/csv,text/plain"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 150_000) {
                    setError("Choose a file smaller than 150 KB.");
                    return;
                  }
                  try {
                    setText(await file.text());
                    setError("");
                  } catch {
                    setError("The file could not be read.");
                  }
                }}
              />
            </label>
            <label className="full-width">
              Company names and domains
              <textarea
                rows={7}
                maxLength={150000}
                value={text}
                required
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  "name,domain\nAcme,acme.com\nExample,https://example.com/careers"
                }
              />
              <small>
                Up to 500 organizations. Paste one domain per line, or name and
                URL columns. CSV headers and quoted names are supported.
              </small>
            </label>
          </>
        )}
        <div className="form-actions">
          <Button disabled={busy}>
            {busy
              ? "Queuing…"
              : mode === "single"
                ? "Add company"
                : "Import companies"}
          </Button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <p>
            {result.imported} queued · {result.duplicates} already imported ·{" "}
            {result.rejected.length} rows skipped.{" "}
            <Link href="/companies">View discovery progress</Link>
          </p>
          {!!result.rejected.length && (
            <ul>
              {result.rejected.slice(0, 30).map((row) => (
                <li key={row.line}>
                  Line {row.line}: {row.reason}
                </li>
              ))}
            </ul>
          )}
          {result.rejected.length > 30 && (
            <p>
              {result.rejected.length - 30} more skipped rows. Check the format
              and 500-row limit.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
