"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, Download, Trash2, Save } from "lucide-react";
import { demoProfile, type Profile } from "@jobfinder/shared";
import { Button } from "./ui/button";
import { api } from "./client";
type ResumeSummary = { id: string; filename: string; size: number };
export function ProfileForm({
  initial,
  resumes,
}: {
  initial: Profile;
  resumes: ResumeSummary[];
}) {
  const [profile, setProfile] = useState(initial);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const router = useRouter();
  const update = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((p) => ({ ...p, [key]: value }));
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">THE EXPERIENCE YOU BRING</span>
          <h1>Your career profile.</h1>
          <p>A thoughtful foundation for a more relevant search.</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setProfile({ ...demoProfile });
            setMessage(
              "Fictional example loaded into the form. Review and save to keep it.",
            );
          }}
        >
          Load example profile
        </Button>
      </div>
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
      <div className="editor-layout">
        <form
          className="panel form-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const clean = { ...profile };
              for (const key of [
                "skills",
                "previousRoles",
                "industries",
                "certifications",
                "education",
                "languages",
                "workAuthorization",
                "companySizeExperience",
              ] as const) {
                clean[key] = clean[key]
                  .map((value) => value.trim())
                  .filter(Boolean);
              }
              await api("profile", "PUT", clean);
              setProfile(clean);
              setMessage("Profile saved.");
            });
          }}
        >
          <div className="section-heading">
            <h2>Your professional story</h2>
            <p>Only share the information you want to use in your search.</p>
          </div>
          <div className="form-grid">
            <label>
              Full name
              <input
                value={profile.name}
                onChange={(e) => update("name", e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Current role
              <input
                value={profile.currentRole}
                onChange={(e) => update("currentRole", e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Location
              <input
                value={profile.location}
                onChange={(e) => update("location", e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Years of experience
              <input
                type="number"
                min={0}
                max={80}
                value={profile.yearsExperience}
                onChange={(e) =>
                  update("yearsExperience", Number(e.target.value))
                }
              />
            </label>
          </div>
          <label>
            Executive summary
            <textarea
              rows={5}
              value={profile.summary}
              onChange={(e) => update("summary", e.target.value)}
              maxLength={10000}
            />
          </label>
          {(
            [
              ["skills", "Skills & expertise"],
              ["previousRoles", "Previous roles"],
              ["industries", "Industries"],
              ["certifications", "Certifications"],
              ["education", "Education"],
              ["languages", "Languages"],
              ["workAuthorization", "Work authorization"],
              ["companySizeExperience", "Company size experience"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                value={profile[key].join(", ")}
                onChange={(e) =>
                  update(
                    key,
                    e.target.value.split(",").map((v) => v.trimStart()),
                  )
                }
              />
              <small>Separate entries with commas.</small>
            </label>
          ))}
          {(
            [
              ["leadershipExperience", "Leadership experience"],
              ["managementExperience", "Management experience"],
              ["architectureExperience", "Technical architecture experience"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <textarea
                rows={3}
                value={profile[key]}
                onChange={(e) => update(key, e.target.value)}
                maxLength={5000}
              />
            </label>
          ))}
          <div className="form-actions">
            <Button disabled={busy}>
              <Save size={16} />
              {busy ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
        <aside>
          <section className="panel form-panel resume-panel">
            <FileText size={24} />
            <h2>Your resume</h2>
            <p className="muted">
              Upload a resume or a LinkedIn-exported document. The original
              stays private and separate from your profile.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                void run(async () => {
                  const result = await api<{ extractedText: string }>(
                    "resumes",
                    "POST",
                    data,
                  );
                  setText(result.extractedText);
                  setMessage(
                    "Resume uploaded. Review the extracted text and update your profile as needed.",
                  );
                  form.reset();
                });
              }}
            >
              <label className="upload-zone">
                <Upload size={23} />
                <strong>Choose your resume</strong>
                <small>PDF, DOCX or TXT · up to 5 MiB</small>
                <input
                  aria-label="Resume file"
                  name="file"
                  type="file"
                  accept=".pdf,.docx,.txt"
                  required
                />
              </label>
              <Button variant="outline" disabled={busy}>
                Upload resume
              </Button>
            </form>
            <div className="resume-list">
              {resumes.map((resume) => (
                <div key={resume.id}>
                  <FileText size={17} />
                  <span>
                    {resume.filename}
                    <small>{Math.ceil(resume.size / 1024)} KB</small>
                  </span>
                  <a
                    className="icon-button"
                    aria-label={`Download ${resume.filename}`}
                    href={`/api/resumes/${resume.id}`}
                  >
                    <Download size={16} />
                  </a>
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`Delete ${resume.filename}`}
                    onClick={() => {
                      void run(async () => {
                        await api(`resumes/${resume.id}`, "DELETE");
                        setMessage("Resume deleted.");
                      });
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </section>
          {text && (
            <section className="panel form-panel">
              <h2>Extracted text</h2>
              <p className="muted">
                Review before adding details to your profile. Structured AI
                suggestions will arrive in a later phase.
              </p>
              <pre className="extracted-text">{text}</pre>
            </section>
          )}
          <p className="privacy-note">
            Your resume is visible only to your account. Phase 1 extracts text
            locally; it is not sent to an AI provider.
          </p>
        </aside>
      </div>
    </>
  );
}
