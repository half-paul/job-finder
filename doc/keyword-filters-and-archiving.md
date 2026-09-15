# Keyword import filters and archiving

Requested behaviour: specify keywords to look for in job postings, import postings only when those keywords are found, and archive listings so they are counted nowhere and never imported again. This note records the decisions and the local validation. The product specification remains [the requirements](AI%20Job%20Finder%20Web%20App%20-%20requirements.md); the wider design is in [architecture](architecture.md).

## Decisions

- **Keyword gate at import time, not at scoring time.** `career_preferences.includeKeywords` and `career_preferences.negativeKeywords` are read once per scan and applied to each normalized listing before it can be inserted. Exclusions always win, an empty required list imports everything, and matching is case-insensitive and whitespace-insensitive against title, company and description. Keywords deliberately do not affect the match score: the requirements warn against relying on keyword matching for ranking, so this stays a deterministic import filter rather than a `JobMatch` input.
- **Filtered listings are never inserted.** They are counted per scan (`search_runs.filtered`), reported in the sync summary and source messages, and pushed to the scan's `seen` set. That last detail matters: a listing that would now be filtered is not treated as missing, so adding a keyword never deletes or hides postings imported earlier — the user archives those instead.
- **Archiving is a sticky column, not a status.** `jobs.archived_at` is set and cleared by `PUT /api/jobs/:id/archive`. Re-using `saved_jobs.status` or `jobs.lifecycle` was rejected because both are rewritten by discovery (a re-appearing listing sets `lifecycle` back to `Active`), which would silently un-archive a listing. `archived_at` is never written by the sync path.
- **Archived means uncounted and hidden everywhere.** List views (all, saved, applications), dashboard counts, saved/application counts, country filtering results and the automatic evaluation batch all exclude archived rows. The archived view (`/archived`) and the detail page still resolve the listing so it can be restored with its status, notes and history intact.
- **Never imported again.** Archiving keeps the row, so its `canonical_hash` and `job_references` provenance still exist. A later scan matches the canonical row and updates it in place (or leaves it unchanged) instead of inserting the posting again, and a duplicate manual add is still rejected with the existing 409.
- **Manual entries bypass the gate.** Import filtering protects against feed noise; a listing the user typed in is deliberate and is never keyword-filtered.

## Verification

Validated on 2026-09-14 with Node 24.15.0 on the host, PostgreSQL 16 with pgvector in Compose, and Playwright Chromium. Compose web and migrate containers were rebuilt and migrated before the browser tests.

| Check                        | Command                                                                                           | Result                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Formatting                   | `npm run format:check`                                                                            | Passed                                                                                 |
| Lint                         | `npm run lint`                                                                                    | Passed                                                                                 |
| TypeScript                   | `npm run typecheck`                                                                               | Passed                                                                                 |
| Deterministic unit tests     | `npm test`                                                                                        | 42 passed across six files (keyword gate covers required/blocked/blank/case rules)     |
| Schema drift                 | `npm run db:generate`                                                                             | Re-run after the migration: no schema changes                                          |
| Migration                    | `npm run db:migrate`                                                                              | Passed (`jobs.archived_at`, `search_runs.filtered`)                                    |
| Default browser/API suite    | `npm run test:e2e`                                                                                | 10 passed, 3 external smoke tests skipped                                              |
| Live discovery smoke         | `DISCOVERY_LIVE_SMOKE=1 npm run test:e2e -- tests/e2e/discovery-live.spec.ts`                     | 2 passed against the public Lever demo board                                           |
| Container rebuild/readiness  | `docker compose up -d --build --wait web`                                                         | Migration succeeded; PostgreSQL and web healthy                                        |
| Desktop/mobile visual review | `test-results/archiving-desktop.png`, `archiving-mobile.png`, `preferences-countries-desktop.png` | Archive view, row actions and keyword fields readable; no horizontal overflow at 390px |
| Patch hygiene                | `git diff --check`                                                                                | Passed                                                                                 |

Agent shell commands use `rtk proxy` before the commands shown here, per `AGENTS.md`.

Observed behaviour:

- Browser test `tests/e2e/archiving.spec.ts` archives from the list, checks that the dashboard "Opportunities" count drops 2 → 1 and "Saved" drops 1 → 0, that the row leaves the list, that `GET /api/jobs?view=archived` and the detail page still resolve it, that the automatic evaluation batch selects 0 while archived and 1 after restore, that a duplicate add of the same canonical URL is still rejected, and that archiving from the detail page shows the restore control.
- The live smoke asserted the keyword gate end to end against the Lever demo feed: with a required keyword that cannot appear, `added` was 0 while `filtered` equalled the normalizable listings and the warning "listings were skipped by your keyword filters" was recorded; clearing the keyword imported 11 listings; blocking keywords ("a", "e", "the", "and") imported none and filtered all of them; and after archiving one imported listing a further full scan still left exactly one row for its canonical hash with `archived_at` set, absent from the default list and present in the archive view.
- Four postings in that public demo feed publish no usable description, so they are reported as per-listing warnings and never counted as filtered. That is pre-existing normalization behaviour, not the keyword gate.
- Screenshots live in the Playwright output directory (ignored `test-results/`); both live smoke tests delete their synthetic account and cascading records in `finally`.

## Known limitations

- Keyword matching is substring-based, so a keyword also matches inside a longer word (`director` matches `directorate`) and no stemming, synonyms or word boundaries are applied. Title/company/description only; structured fields such as location or industry are not searched.
- The gate applies to discovery imports. It does not retroactively remove listings imported before a keyword was added, and it does not hide them: use archiving for that.
- Previously filtered listings are remembered only through the canonical/`seen` logic of each scan, so a source that later changes a listing's URL can re-introduce it as a new job.
- `search_runs.filtered` stores a count, not the individual skipped listings, so there is no per-keyword diagnostic or "why was this skipped" history.
- Archiving is a per-row flag on a private job record. If shared/public listings are ever introduced (the schema still allows a null `owner_id`), archiving will need a per-user table instead.
