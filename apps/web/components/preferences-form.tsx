"use client";
import { useState } from "react";
import { Plus, Save, X } from "lucide-react";
import {
  type Preferences,
  employmentTypes,
  seniorityLevels,
  workTypes,
} from "@jobfinder/shared";
import { api } from "./client";
import { Button } from "./ui/button";
export function PreferencesForm({ initial }: { initial: Preferences }) {
  const [data, setData] = useState(initial);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setData((p) => ({ ...p, [key]: value }));
  const total = Object.values(data.weights).reduce((a, b) => a + b, 0);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DEFINE YOUR DIRECTION</span>
          <h1>What matters in your next role?</h1>
          <p>Separate your must-haves from the things you’d love to find.</p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const clean = { ...data };
            for (const key of [
              "includedLocations",
              "excludedLocations",
              "excludedCompanies",
              "preferredCompanies",
              "industries",
              "negativeKeywords",
            ] as const)
              clean[key] = clean[key].map((s) => s.trim()).filter(Boolean);
            await api("preferences", "PUT", clean);
            setData(clean);
            setMessage("Preferences saved.");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <h2>Roles on your horizon</h2>
              <p>Group related roles and assign a priority from 1 to 10.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                update("targetRoles", [
                  ...data.targetRoles,
                  { title: "", group: "", weight: 8 },
                ])
              }
            >
              <Plus size={16} />
              Add role
            </Button>
          </div>
          {data.targetRoles.length === 0 && (
            <p className="muted">
              Start with a role you would be excited to explore.
            </p>
          )}
          {data.targetRoles.map((role, i) => (
            <div className="role-row" key={i}>
              <label>
                Target role
                <input
                  required
                  placeholder="e.g. VP Infrastructure"
                  value={role.title}
                  onChange={(e) =>
                    update(
                      "targetRoles",
                      data.targetRoles.map((r, j) =>
                        j === i ? { ...r, title: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Role group
                <input
                  placeholder="Infrastructure leadership"
                  value={role.group}
                  onChange={(e) =>
                    update(
                      "targetRoles",
                      data.targetRoles.map((r, j) =>
                        j === i ? { ...r, group: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Priority
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={role.weight}
                  onChange={(e) =>
                    update(
                      "targetRoles",
                      data.targetRoles.map((r, j) =>
                        j === i ? { ...r, weight: Number(e.target.value) } : r,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove role ${i + 1}`}
                onClick={() =>
                  update(
                    "targetRoles",
                    data.targetRoles.filter((_, j) => j !== i),
                  )
                }
              >
                <X size={18} />
              </button>
            </div>
          ))}
        </section>
        <div className="two-columns">
          <section className="panel form-panel">
            <h2>The way you want to work</h2>
            {(
              [
                ["employmentTypes", "Employment type", employmentTypes],
                [
                  "workTypes",
                  "Work arrangement",
                  workTypes.filter((v) => v !== "Unknown"),
                ],
                [
                  "seniority",
                  "Seniority",
                  seniorityLevels.filter((v) => v !== "Unknown"),
                ],
              ] as const
            ).map(([key, label, values]) => (
              <fieldset key={key}>
                <legend>{label}</legend>
                <div className="checkbox-grid">
                  {values.map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={(data[key] as string[]).includes(value)}
                        onChange={(e) => {
                          const selected: string[] = [...data[key]];
                          update(
                            key,
                            (e.target.checked
                              ? [...selected, value]
                              : selected.filter(
                                  (v) => v !== value,
                                )) as (typeof data)[typeof key],
                          );
                        }}
                      />
                      {value}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <label className="check-label">
              <input
                type="checkbox"
                checked={data.allowRelocation}
                onChange={(e) => update("allowRelocation", e.target.checked)}
              />
              Open to relocation
            </label>
            <label>
              Maximum on-site distance (km)
              <input
                type="number"
                min={0}
                max={1000}
                value={data.onsiteRadiusKm}
                onChange={(e) =>
                  update("onsiteRadiusKm", Number(e.target.value))
                }
              />
            </label>
          </section>
          <section className="panel form-panel">
            <h2>Places and companies</h2>
            {(
              [
                ["includedLocations", "Included locations"],
                ["excludedLocations", "Excluded locations"],
                ["preferredCompanies", "Preferred companies"],
                ["excludedCompanies", "Excluded companies"],
                ["industries", "Preferred industries"],
                ["negativeKeywords", "Discouraged roles or keywords"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={data[key].join(", ")}
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
          </section>
        </div>
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <h2>Skills and experience</h2>
              <p>
                Required and excluded skills take precedence over softer
                preferences.
              </p>
            </div>
            <Button
              variant="outline"
              type="button"
              onClick={() =>
                update("skills", [
                  ...data.skills,
                  { name: "", preference: "Preferred", weight: 5 },
                ])
              }
            >
              <Plus size={16} />
              Add skill
            </Button>
          </div>
          {data.skills.map((skill, i) => (
            <div className="role-row" key={i}>
              <label>
                Skill
                <input
                  required
                  value={skill.name}
                  onChange={(e) =>
                    update(
                      "skills",
                      data.skills.map((s, j) =>
                        i === j ? { ...s, name: e.target.value } : s,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Preference
                <select
                  value={skill.preference}
                  onChange={(e) =>
                    update(
                      "skills",
                      data.skills.map((s, j) =>
                        i === j
                          ? {
                              ...s,
                              preference: e.target.value as typeof s.preference,
                            }
                          : s,
                      ),
                    )
                  }
                >
                  {["Required", "Preferred", "Neutral", "Excluded"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                Weight
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={skill.weight}
                  onChange={(e) =>
                    update(
                      "skills",
                      data.skills.map((s, j) =>
                        i === j ? { ...s, weight: Number(e.target.value) } : s,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove skill ${i + 1}`}
                onClick={() =>
                  update(
                    "skills",
                    data.skills.filter((_, j) => i !== j),
                  )
                }
              >
                <X size={18} />
              </button>
            </div>
          ))}
        </section>
        <div className="two-columns">
          <section className="panel form-panel">
            <h2>Compensation</h2>
            <p className="muted">
              Unknown compensation will remain visible. No currency conversion
              is assumed.
            </p>
            <div className="form-grid">
              {(
                [
                  ["salaryMin", "Minimum annual salary"],
                  ["salaryPreferred", "Preferred annual salary"],
                  ["salaryMax", "Maximum annual salary"],
                  ["hourlyRate", "Hourly contract rate"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min={0}
                    value={data[key] ?? ""}
                    onChange={(e) =>
                      update(
                        key,
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                  />
                </label>
              ))}
              <label>
                Currency
                <select
                  value={data.currency}
                  onChange={(e) =>
                    update(
                      "currency",
                      e.target.value as Preferences["currency"],
                    )
                  }
                >
                  {["CAD", "USD", "EUR", "GBP"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Equity
                <select
                  value={data.equityPreference}
                  onChange={(e) =>
                    update(
                      "equityPreference",
                      e.target.value as Preferences["equityPreference"],
                    )
                  }
                >
                  {["Neutral", "Preferred", "Required"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset>
              <legend>Hard requirements</legend>
              <p className="muted">
                These constraints will gate AI ranking when matching is enabled.
              </p>
              <div className="checkbox-grid">
                {(
                  Object.keys(
                    data.hardRequirements,
                  ) as (keyof Preferences["hardRequirements"])[]
                ).map((key) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={data.hardRequirements[key]}
                      onChange={(e) =>
                        update("hardRequirements", {
                          ...data.hardRequirements,
                          [key]: e.target.checked,
                        })
                      }
                    />
                    {key}
                  </label>
                ))}
              </div>
            </fieldset>
          </section>
          <section className="panel form-panel">
            <h2>How you weigh a match</h2>
            <p className="muted">
              Configure the future matching engine. Weights must total 100.
            </p>
            {(
              Object.keys(data.weights) as (keyof Preferences["weights"])[]
            ).map((key) => (
              <label className="weight-row" key={key}>
                <span>{key}</span>
                <input
                  aria-label={`${key} weight`}
                  type="number"
                  min={0}
                  max={100}
                  value={data.weights[key]}
                  onChange={(e) =>
                    update("weights", {
                      ...data.weights,
                      [key]: Number(e.target.value),
                    })
                  }
                />
                <span>%</span>
              </label>
            ))}
            <div
              className={total === 100 ? "weight-total" : "weight-total error"}
            >
              Total <strong>{total}%</strong>
            </div>
          </section>
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
        <div className="form-actions sticky-actions">
          <span>Explicit preferences always come first.</span>
          <Button disabled={busy || total !== 100}>
            <Save size={16} />
            {busy ? "Saving…" : "Save preferences"}
          </Button>
        </div>
      </form>
    </>
  );
}
