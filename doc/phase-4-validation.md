# Phase 4 local validation

Validated on 2026-09-15 with Node 24.15.0, PostgreSQL 16 with pgvector on the host database, and Playwright Chromium. This report covers the local implementation; hosted CI and production deployment were not run.

## What Phase 4 adds

- `apps/worker` (`@jobfinder/worker`): a pg-boss process with four queues — `scan-source`, `schedule-sources` (every minute), `evaluate-batch` and `housekeeping` (hourly). It publishes no ports, runs no HTTP server, and is the only process that performs scheduled discovery, scheduled evaluation, alert creation, digest generation and cleanup.
- `packages/automation` (`@jobfinder/automation`): the Next.js-free service layer both processes share — the source scan engine, the bounded evaluation batch, watchlist management, alerts, the daily digest, schedule arithmetic, expired-row cleanup and automation diagnostics.
- Schema additions (migration `0005_bouncy_firelord.sql`, 20 tables total): `company_watchlists`, `notifications`, `automation_state`, plus `job_sources.schedule/next_run_at/last_checked_at` and `search_runs.trigger/duration_ms`.
- API additions: `GET/POST /api/watchlist`, `PUT/DELETE /api/watchlist/:id`, `GET /api/notifications`, `POST /api/notifications/mark`, `GET /api/automation`, `POST /api/automation/digest`, `PUT /api/sources/:id/schedule`, and an `alertsCreated` count on `POST /api/jobs/evaluation-batch`.
- UI additions: a Watchlist page, an Automation diagnostics page (worker health, per-source schedule and last result, on-demand digest, search history), a Notifications page with a topbar unread bell, and alert/digest fields in Preferences.

## Verification matrix

| Check                                | Command                                            | Result                                                                            |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Formatting                           | `npm run format:check`                             | Passed                                                                            |
| Lint                                 | `npm run lint`                                     | Passed                                                                            |
| TypeScript                           | `npm run typecheck`                                | Passed                                                                            |
| Deterministic unit tests             | `npm test`                                         | 52 passed across seven files                                                      |
| Schema drift                         | `npm run db:generate`                              | 20 tables; no schema changes                                                      |
| Migration against the local database | `npm run db:migrate`                               | Passed; Phase 4 tables and columns applied                                        |
| Host production build                | `npm run build`                                    | Passed, including the new `/watchlist`, `/automation` and `/notifications` routes |
| Default integration suite            | `npm run test:e2e`                                 | 15 passed, 3 opt-in live tests skipped                                            |
| Phase 4 integration tests            | `npm run test:e2e -- tests/e2e/automation.spec.ts` | Five passed against real PostgreSQL                                               |
| Worker start and queue creation      | `npm run worker`                                   | Four queues created; heartbeats written every 60 seconds                          |
| Worker scheduled scan                | Real worker run against the Lever demo board       | Scan claimed, imported 11 listings, marked zero removed, no re-import on replay   |
| Worker graceful shutdown             | `kill -TERM <worker pid>`                          | `worker_stopping` then `worker_stopped`; pool closed                              |

Agent shell commands use `rtk proxy` before the commands shown here, per `AGENTS.md`.

## Coverage added in this phase

- Unit tests cover UTC schedule alignment for every interval (including strict-after behaviour at an exact boundary), recommendation bands, watchlist key normalization and schema defaults, alert/digest dedupe-key identity, legacy preference parsing, and threshold range validation.
- The Phase 4 integration test covers watchlist creation owning a directly-scanned Greenhouse source, normalized duplicate rejection, a provider without a board, cross-account scoping with a separate cookie jar, priority updates, and removal disabling the source rather than deleting its provenance.
- The same test drives the real worker handler with an injected provider fixture: the run is recorded as `Schedule`, `duration_ms` is persisted, the schedule advances to a future aligned instant, the listing imports exactly once, and replaying the same pg-boss job id reuses one `search_runs` row and imports nothing twice.
- Alerts and the digest are verified as opt-in, deterministic and idempotent: one alert for an evaluation, none on replay, mark-read accounting, a digest that counts and orders deterministically, and one digest notification per UTC hour.
- Housekeeping removes an expired session row and an expired rate-limit bucket; the worker run removed a real expired rate-limit bucket left by the integration suite.
- Source schedules are validated (`Whenever` rejected with 400), applied on aligned UTC boundaries, cleared by `Manual`, and rejected with 404 for a source the caller does not own.

## Observed worker run

A real `npm run worker` process against the local database produced, in order: `worker_started` with all four queues, `schedule_tick` claiming one due source, `scan_completed` for the Lever demo board (`Succeeded`, 11 added, 0 removed, evaluation queued), `evaluation_completed`, and `housekeeping_completed`. Two listings were skipped with a recorded per-job warning because their descriptions were under the 20-character minimum; the scan still completed and marked nothing removed. The evaluation batch reported `evaluated: 0, failed: 1` because the synthetic fixture account had an empty profile, which the evaluator refuses before any model call — a failure was recorded instead of an invented score, and the worker stayed up. The next hourly tick re-ran the scan, added nothing and enqueued no evaluation, which is the intended no-op path. The fixture account was removed afterwards.

## Reproduce locally

```sh
docker compose up -d postgres
npm run db:migrate
npm run lint
npm run typecheck
npm run format:check
npm test
npm run db:generate
npm run build
npm run test:e2e -- tests/e2e/automation.spec.ts
npm run worker      # in a second terminal, for scheduled scans and digests
```

`docker compose up --build -d --wait` now starts PostgreSQL, migrations, web and worker. Stop the Compose web service (`docker compose stop web`) before verifying a host build, so Playwright does not silently test the older container. The worker needs `DATABASE_URL` and reads the same ignored `.env.local` as the other commands; it does not need `APP_ORIGIN`, and it publishes no ports.

## Remaining implementation boundaries

- The interactive `POST /api/sources/:id` sync still runs inside the Next.js request path. It is user-triggered, bounded and observable, and it shares the scan engine and advisory lock with the worker, but the plan's stronger wording — that every scan runs outside the request path — is not met yet. Routing the interactive sync through the `scan-source` queue and polling the run row is the follow-up.
- Scheduled work requires the worker process. Without it, the Automation page reports "Not running" and no scheduled scan, digest or cleanup happens. There is no queue-level enforcement that a second worker instance would not double-run beyond the guarded claim, the per-source advisory lock and the pg-boss queue policies.
- The monthly budget guard is unchanged from Phase 3: it is a pre-request estimate against the latest saved match costs, not an enforceable billing cap. Scheduled evaluation inherits that limitation. A failing evaluation stops the batch and is recorded, but retries re-attempt it.
- Digest `newJobs` counts every job visible to the user (`owner_id` is null or theirs) discovered inside the window and does not apply the country pre-filter, so the count can exceed the filtered list.
- Alerts are in-app only. Email, web push, Slack, SMS and Telegram are unimplemented and are not implied anywhere in the UI. The digest narrative is the only model call in this phase and is opt-in per request.
- Evaluated alerts are created after evaluation completes. An alert is never created for a job that was never evaluated, so a high-scoring but unevaluated listing stays silent by design.
- Watchlist entries only scan employers whose board identity the existing Greenhouse, Lever or Ashby connectors can resolve; other ATS providers arrive with Phase 5. Company discovery and career-URL resolution are not part of this phase.
- The worker runs TypeScript through `tsx`, matching the existing `db:migrate` command. No compiled worker artifact is produced.
