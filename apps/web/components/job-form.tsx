"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { employmentTypes, workTypes, seniorityLevels } from "@jobfinder/shared";
import { Button } from "./ui/button";
import { api } from "./client";
export function JobForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <>
      <Link className="back-link" href="/jobs">
        <ArrowLeft size={16} />
        All opportunities
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">A POSSIBILITY WORTH KEEPING</span>
          <h1>Add an opportunity.</h1>
          <p>
            Capture a real listing you want to consider. It stays private to
            your account.
          </p>
        </div>
      </div>
      <form
        className="panel form-panel narrow-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          setError("");
          try {
            const job = await api<{ id: string }>("jobs", "POST", {
              ...form,
              salaryMin: form.salaryMin ? Number(form.salaryMin) : null,
              salaryMax: form.salaryMax ? Number(form.salaryMax) : null,
              postedAt: form.postedAt
                ? new Date(String(form.postedAt)).toISOString()
                : null,
            });
            router.push(`/jobs/${job.id}`);
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label>
            Job title
            <input name="title" required minLength={2} maxLength={200} />
          </label>
          <label>
            Company
            <input name="company" required maxLength={200} />
          </label>
          <label>
            Location
            <input
              name="location"
              placeholder="Vancouver, Canada"
              maxLength={200}
            />
          </label>
          <label>
            Country
            <input name="country" maxLength={200} />
          </label>
          <label>
            Industry
            <input name="industry" maxLength={200} />
          </label>
          <label>
            Work arrangement
            <select name="workType" defaultValue="Unknown">
              {workTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Employment type
            <select name="employmentType">
              {employmentTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Seniority
            <select name="seniority" defaultValue="Unknown">
              {seniorityLevels.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Minimum annual salary
            <input name="salaryMin" type="number" min={0} />
          </label>
          <label>
            Maximum annual salary
            <input name="salaryMax" type="number" min={0} />
          </label>
          <label>
            Currency
            <select name="currency">
              {["CAD", "USD", "EUR", "GBP"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Date posted
            <input name="postedAt" type="date" />
          </label>
        </div>
        <label>
          Original listing URL
          <input
            name="jobUrl"
            type="url"
            required
            placeholder="https://company.com/careers/role"
          />
        </label>
        <label>
          Job description
          <textarea
            name="description"
            rows={12}
            required
            minLength={20}
            maxLength={100000}
            placeholder="Paste the responsibilities, requirements and any details that matter to you."
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button disabled={busy}>
            <Plus size={17} />
            {busy ? "Adding…" : "Add opportunity"}
          </Button>
        </div>
      </form>
    </>
  );
}
