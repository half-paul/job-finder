# Phase 3 local validation

Validated on 2026-09-14 with Node 24.15.0 on the host, Node 24.21.0 in Docker, PostgreSQL 16 with pgvector, and Playwright Chromium. This report covers the local implementation; hosted CI and production deployment were not run.

## Verification matrix

| Check                           | Command                                                                       | Result                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Formatting                      | `npm run format:check`                                                        | Passed                                                                          |
| Lint                            | `npm run lint`                                                                | Passed                                                                          |
| TypeScript                      | `npm run typecheck`                                                           | Passed                                                                          |
| Deterministic unit tests        | `npm test`                                                                    | 30 passed across five files                                                     |
| Dependency audit                | `npm audit --audit-level=moderate`                                            | Zero known vulnerabilities at verification time                                 |
| Schema drift                    | `npm run db:generate`                                                         | 17 tables; no schema changes                                                    |
| Existing database migrations    | `npm run db:migrate`                                                          | Passed, including replay during Compose startup                                 |
| Clean database migrations       | Migration container against a separate empty database, then replay            | Passed after fixing extension initialization order                              |
| Host production build           | `npm run build`                                                               | Passed                                                                          |
| Default integration suite       | `npm run test:e2e`                                                            | Five passed; two external smoke tests skipped intentionally                     |
| Lever live smoke                | `DISCOVERY_LIVE_SMOKE=1 npm run test:e2e -- tests/e2e/discovery-live.spec.ts` | Passed against host and Docker                                                  |
| OpenAI live smoke               | `AI_LIVE_SMOKE=1 npm run test:e2e -- tests/e2e/matching-live.spec.ts`         | Passed against host and Docker                                                  |
| Container build/start/readiness | `docker compose up --build -d --wait`                                         | Migration succeeded; PostgreSQL and web healthy                                 |
| Desktop/mobile visual review    | Screenshots from browser and live matching tests                              | Scores, evidence, errors and controls readable; no horizontal overflow at 390px |
| Patch hygiene                   | `git diff --check`                                                            | Passed                                                                          |

Agent shell commands use `rtk proxy` before the commands shown here, per `AGENTS.md`.

## Coverage and observed behavior

- Unit tests cover aggregation, cosine similarity, hard requirements, deterministic evidence text, output schemas, token/cost calculation, refusal/malformed/out-of-range evaluation rejection, invalid embedding dimensions and provider errors, alongside existing security/parser/connector tests. They use injected fetch fixtures and require no API key or network.
- Real PostgreSQL/API tests cover account/session persistence and revocation, foreign keys, pgvector, origin checks, source ownership, hard-filter precedence, and zero-budget rejection with no saved match.
- Browser tests cover account/profile/preferences/resume/job workflows, cross-account access including evaluation, missing-profile errors, saved state/history, filtering, mobile layout, theme and sign-in/out.
- Live matching uses only a fictional executive and synthetic listing. It verifies real scores within 0–100, positive token/cost usage, saved matching data, one target/job embedding each, successful UI re-evaluation with zero new embedding tokens, and target-embedding invalidation after saving the profile.
- In the observed Docker cache check, the first evaluation used 668 input, 225 output and 160 embedding tokens (estimated USD 0.001517). Re-evaluation used 669 input, 260 output and zero embedding tokens (estimated USD 0.001672). These are application estimates for that run, not a billing statement or stable model output.
- Live discovery verifies import, idempotent re-import, description updates and complete-scan removal using Lever's public demo board. Other connectors have deterministic fixture coverage, not live coverage in this session.
- Both live tests now delete their synthetic user and cascading records in `finally`, including after an assertion fails. Ordinary integration tests retain synthetic `@example.test` records. Earlier live runs before the cleanup fix may also have retained synthetic records.

## Reproduce locally

Use Node 22+ and Docker Compose 2.24+. Install dependencies with `npm ci` and Chromium with `npm exec playwright install chromium`. Preserve any existing `.env.local`.

```sh
docker compose up -d postgres
npm run db:migrate
npm run lint
npm run typecheck
npm run format:check
npm test
npm run db:generate
npm audit --audit-level=moderate
npm run build
docker compose stop web
npm run test:e2e
```

Playwright reuses an existing healthy localhost:3000 server outside CI. Stop the Compose web service before verifying a host build, and ensure the app and test process use the same database. To load a custom database URL from `.env.local` into both processes:

```sh
node --env-file=.env.local node_modules/@playwright/test/cli.js test
```

Live tests are opt-in, require network access, and the AI test makes paid OpenAI requests using the existing configured key. Flags must equal `1`. No real resume is sent. The extended AI smoke makes two evaluations to verify embedding reuse.

```sh
AI_LIVE_SMOKE=1 DISCOVERY_LIVE_SMOKE=1 npm run test:e2e -- tests/e2e/matching-live.spec.ts tests/e2e/discovery-live.spec.ts
docker compose up --build -d --wait
npm run test:e2e
```

To exercise the same live tests against Docker, repeat the opt-in command after Compose starts. Compose web reads `.env.local` at runtime; the file is excluded from the image. Restart with `docker compose up -d --force-recreate web` after changing AI configuration. Avoid printing resolved Compose configuration because it can include credentials.

For an isolated fresh migration check, choose an unused database name and use it consistently:

```sh
docker compose exec -T postgres createdb -U jobfinder jobfinder_verify_20260914
docker compose run --rm -e DATABASE_URL=postgresql://jobfinder:local-development-only@postgres:5432/jobfinder_verify_20260914 migrate
docker compose run --rm -e DATABASE_URL=postgresql://jobfinder:local-development-only@postgres:5432/jobfinder_verify_20260914 migrate
```

The separate validation database contains no user fixtures. The ordinary E2E runs use the development database, not this empty migration-check database. Screenshots and failure traces are generated under ignored `test-results/`; Playwright clears previous artifacts when a new run begins. Matching screenshots require the opt-in AI test.

## Fixes found during verification

- Fresh installation failed because migration execution preceded `CREATE EXTENSION vector`. The runner now enables pgvector first and closes its pool in `finally`.
- Compose did not pass AI/JSON-LD configuration to web. It now reads optional `.env.local`, while preserving the container database URL and local application origin.
- A browser assertion matched both the application error and Next.js route announcer. It now scopes to the matching panel.
- Live test cleanup previously missed early failures; teardown now covers the full post-registration workflow.

## Remaining implementation boundaries

- The monthly budget is a pre-request estimate check against the latest saved match per job, not an enforceable billing cap. Re-evaluation overwrites prior usage; failed requests and concurrent in-flight calls are not fully accounted for. An append-only ledger, atomic reservations and model-specific pricing remain necessary.
- Cost constants assume the default models. Embeddings require 1,536 dimensions. Changing model environment variables alone does not update cost assumptions, dimensions or the fixed explanation version label.
- Profile/preferences changes clear target embeddings but leave saved scores visible until manually re-evaluated. Immutable evaluation input snapshots and stale-score indicators remain follow-up work.
- Hard filters currently cover location, employment, seniority and comparable salary. Work authorization and excluded companies/skills are not hard-enforced. Remote location handling does not establish legal work eligibility.
- Embeddings are stored in pgvector, but similarity for an individual evaluation is calculated in application code. Bulk nearest-neighbor retrieval, scheduled evaluation, automation and alerts remain future work.
- Live smoke proves end-to-end compatibility and persistence for a synthetic example; it does not establish matching quality or calibration. Model responses vary.
- The authentication, storage and operational prerequisites in `README.md` still apply before public deployment. No hosted CI run or cloud deployment was performed.
