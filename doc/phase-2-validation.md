# Phase 2 validation

Validated locally on 2026-09-14 using Node 24, PostgreSQL 16 + pgvector, Chromium, Docker Compose, and Lever's public demo API. No OpenAI request was made.

## Completed checks

- `npm run lint`: passed with no warnings.
- `npm run typecheck`: passed.
- `npm run format:check`: passed.
- `npm test`: 20 deterministic tests passed, including HTML-to-text sanitization, Greenhouse/Lever/RemoteOK/JSON-LD normalization, missing-field handling, source caching, provider-name validation, and Retry-After parsing.
- `npm run db:generate`: no schema drift after generating the `job_sources.company` migration.
- `npm run db:migrate`: applied successfully.
- `npm audit --audit-level=moderate`: zero known vulnerabilities.
- `npm run build`: passed and generated the `/discovery` route.
- `npm run test:e2e`: 4 real PostgreSQL/API/browser tests passed; the opt-in external-source smoke test was skipped by default.
- Opt-in live smoke (`DISCOVERY_LIVE_SMOKE=1` plus the Lever demo test): passed. Verified live import, re-import idempotency, changed-description update, and complete-scan removal lifecycle. Synthetic live-smoke accounts and their imported data were deleted afterward.
- `docker compose up --build -d --wait`: final Compose build, migration, web, and PostgreSQL health checks passed.
- `git diff --check`: passed.

## Connector verification

- Greenhouse: official list/detail endpoints, `content=true`, cached complete list, Zod-validated fields.
- Lever: official paginated postings API, 100-item pages, both documented `on-site` and observed `onsite` values, salary and workplace normalization.
- Ashby: official public job-board endpoint with compensation; no per-job endpoint is documented, so the validated complete board is cached and searched.
- RemoteOK: permitted public feed, legal metadata record ignored, zero salary treated as unknown.
- JSON-LD: JSON-LD `JobPosting` extraction, explicit hostname allowlist, HTTPS/public-host transport policy.

## Remaining boundaries

- Source scans are synchronous and user-triggered; resumable scheduling, retries, watchlists and alerts remain Phase 4.
- Scans stop safely at 5,000 jobs and record `Partial` without marking removals; cursor-incomplete pages are handled the same way.
- OpenAI is still unused; embeddings and validated explanations remain Phase 3.
- Live smoke coverage exercised Lever only. Greenhouse, Ashby, RemoteOK, and JSON-LD use deterministic fixtures and official endpoint shapes.
- The hosted GitHub Actions run has not been triggered in this session.
