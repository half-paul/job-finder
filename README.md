# JobFinder AI

A private career workspace for collecting opportunities and defining what your next role should look like. See the [requirements](doc/AI%20Job%20Finder%20Web%20App%20-%20requirements.md), [architecture and phased plan](doc/architecture.md), [Phase 2 validation](doc/phase-2-validation.md), [Phase 3 validation](doc/phase-3-validation.md), [Phase 4 validation](doc/phase-4-validation.md), and [keyword filters and archiving](doc/keyword-filters-and-archiving.md).

## Implemented: Phase 1 foundation + Phase 2 discovery + Phase 3 matching + Phase 4 automation

- Next.js App Router, React, strict TypeScript, Tailwind and accessible Radix/variant-based UI primitives.
- PostgreSQL 16 with pgvector, Drizzle schema and checked-in migrations.
- Email/password accounts, scrypt hashing, opaque database sessions, logout, CSRF origin checks and database-backed authentication/upload rate limits.
- Private structured profiles; configurable target roles/groups, weighted skills, location, work, seniority, compensation and ranking preferences.
- Private TXT, text-based PDF and DOCX upload, local text extraction, original download and deletion. Up to 10 documents per account, 5 MiB each. Scanned PDFs need OCR first.
- Dashboard, live search/work/score filters, pagination, saved jobs, application status, detail pages, private notes and status history. Manual job entry makes the workspace usable before discovery connectors arrive.
- Responsive layout, keyboard-accessible controls, light/dark toggle, empty states and explicit unevaluated matches.
- Multi-employer RemoteOK, Jobicy, Remotive, The Muse, Himalayas, We Work Remotely, USAJOBS and Adzuna feeds for cross-company discovery. Global feeds need only a provider; no company, board or search URL, though USAJOBS and Adzuna will not scan until their API credentials are set. Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters, Rippling and allowlisted JSON-LD `JobPosting` pages remain available as employer-specific connectors.
- Hardened source transport: HTTPS only, fixed public hosts, no redirects, DNS pinning against rebinding, public-address checks, response-size and timeout limits.
- Provider-specific validation and normalization with unknown values left explicit, HTML converted to bounded plain text, and complete-feed caching to avoid duplicate source requests.
- Private source management and user-triggered scans. Imports preserve provider/external IDs and source URLs and upsert changed descriptions idempotently. Complete, employer-owned feeds mark missing jobs removed; rolling multi-employer feeds never do.
- Search diagnostics record seen/added/changed/removed counts and per-job warnings without aborting the rest of a scan.
- Phase 3 AI matching using `text-embedding-3-small` and GPT-5.4 Mini Structured Outputs.
- Cached 1,536-dimensional pgvector embeddings for the user's target profile and each listing; profile/preference changes invalidate the target vector.
- Hard requirements run before any AI request. Employment, location, seniority and comparable salary constraints return an explicit blocked reason. Work arrangement and seniority both offer an **Unknown** choice, and a posting that omits either value is still evaluated: the AI infers it from the description instead of rejecting the listing for the missing field.
- Strict JSON Schema validation for factor scores, confidence, reasons, gaps and progression. Invalid or unavailable AI never persists an invented score.
- Deterministic score aggregation with semantic evidence blended into role fit, plus persisted input/output/embedding token counts and estimated cost.
- User-configurable monthly AI budget check against stored evaluation costs; see the accounting limitations below.
- Country selection in Preferences filters the opportunity list and excludes out-of-scope jobs from evaluation, with explicit switches for worldwide and unknown-location jobs.
- Keyword gates on Preferences decide what discovery may import at all: a listing must mention at least one required keyword, a blocking keyword always wins, an empty required list imports everything, and manual entries are never filtered.
- Archiving removes an opportunity from every count, list and automatic evaluation while keeping its canonical identity, so a later sync re-uses the archived row instead of importing that posting again. Archive and restore are available from the list, the archive view and the detail page.
- After a sync, the portal automatically evaluates up to the configured number of eligible new or changed jobs (default 5) and reports the batch result.
- `apps/worker` runs pg-boss in the database we already operate — no Redis. It owns every scheduled scan, scheduled evaluation, alert write, digest and cleanup pass, publishes no ports, and writes a heartbeat the Automation page reads.
- Per-source schedules (Manual, Hourly, Every 4 hours, Twice daily, Daily) are aligned to UTC boundaries. A restart or a duplicated scheduler tick cannot enqueue the same slot twice, a missed slot collapses into one run, and a retried scan reuses the same run row instead of creating a second one.
- Company watchlists with priorities. A watchlist entry that names a supported employer board (Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters or Rippling) owns the employer source the worker scans directly, so that company is checked even when it never appears on a public feed; removing the entry disables the source and keeps its provenance.
- Opt-in in-app alerts when an evaluated match reaches your alert score, deduped per evaluation so nothing is repeated. Nothing is emailed, messaged or pushed; the alert list and unread bell live inside the workspace.
- An opt-in daily digest for a chosen UTC hour, with deterministic counts, ordering and highlights. Generating it on demand is additive, and its narrative sentence is the only model call.
- Automation diagnostics: worker heartbeat and queue depth, each source's schedule, next run and last result, and the recorded search history with duration and counters — plus a clear "Not running" state when the worker is stopped.
- Hourly housekeeping removes expired sessions, expired rate-limit buckets and read notifications older than 90 days.

Discovery is both user-triggered and scheduled. A manual sync scans the global feeds in the request path with visible progress; scheduled scans, evaluation, alerts, digests and cleanup run only in the worker. Application-writing assistance and outbound notification channels (email, push, Slack, SMS) are **not implemented yet**. The app does not submit applications. Indeed and LinkedIn are not connected and cannot be: Indeed retired its public job-search API, neither publishes a usable replacement, and their terms forbid reading the listings any other way. No sample jobs or shared-password accounts are installed, and no alert, digest or scan result is fabricated while the worker is stopped. The profile editor can load an explicitly labeled fictional executive example into the form for review.

Scans have a 5,000-job safety cap. A capped or cursor-incomplete scan is recorded as **Partial** and never marks older listings removed.

## Start with Docker

Install Docker with Compose 2.24+ and run from the repository:

```sh
docker compose up --build
```

Open **http://localhost:3000**, choose **Create an account**, and create your workspace. Compose starts PostgreSQL, applies migrations, and starts the built web app. Data persists in the `postgres-data` volume. Ports bind to loopback only. The database password is for local development; never reuse it for a public deployment.

```sh
docker compose stop     # stop, retaining data
docker compose up -d    # restart
```

The `web` container optionally reads ignored `.env.local` for AI models/key and the JSON-LD allowlist. Compose overrides `DATABASE_URL` and `APP_ORIGIN` with its local container settings. After changing `.env.local`, run `docker compose up -d --force-recreate web`. The environment file is excluded from image builds.

The `worker` service runs the same image with `npm run worker`. It publishes no ports, depends on the migration service, restarts unless stopped, and is the only place scheduled scans, scheduled evaluation, alerts, the daily digest and cleanup run. Stop it with `docker compose stop worker` if you want to confirm the Automation page reports "Not running" while nothing runs in the background. No Redis is needed: pg-boss keeps its queues in the same PostgreSQL database.

The `crawler` service builds `apps/crawler/Dockerfile` from the `mcr.microsoft.com/playwright:v1.63.0-noble` image and runs `npm run crawler`, an isolated HTTP service (default port 4000) that only `worker` can reach. It never receives `DATABASE_URL`, is on its own Compose network with no route to `postgres` or `web`, and publishes no port. `worker` calls it over `CRAWLER_URL`/`CRAWLER_SECRET` (both set by Compose for local development) to run a Playwright-based careers-page crawl or to capture the JSON API a careers page calls; see [architecture: crawler isolation boundary](doc/architecture.md#crawler-isolation-boundary). Unset `CRAWLER_URL`/`CRAWLER_SECRET` and discovery simply skips these two rungs, falling back to AI extraction with a warning on the candidate's activity feed — nothing is stubbed or fabricated.

```sh
docker compose logs -f worker   # follow scheduled scan and digest activity
docker compose restart worker   # pick up new code or configuration
```

## Develop on the host

Requires Node.js 22+ (Node 24 in Docker/CI), npm and Docker.

```sh
npm ci
cp .env.example .env.local
docker compose up -d postgres
npm run db:migrate
npm run dev
npm run worker   # second terminal: scheduled scans, alerts, digest, cleanup
npm run crawler  # third terminal, optional: browser crawl and captured-API replay
```

Do not overwrite an existing `.env.local`; add only missing configuration. Root `.env.local` is loaded by development, start, worker and migration commands and ignored by Git/Docker. `DATABASE_URL` is required; `APP_ORIGIN` must exactly match the browser origin for writes. The default is `http://localhost:3000`, not `127.0.0.1`. Secure cookies are enabled for HTTPS origins. `OPENAI_API_KEY` is required for AI evaluation, careers extraction fallback and the digest narrative; the rest of the workspace runs without it, and a scheduled evaluation without a key records a failure instead of a score. `CRAWLER_URL` and `CRAWLER_SECRET` point the worker at the crawler service; leave them unset to skip the captured-API and browser rungs. `npm run crawler` needs Playwright's Chromium installed (`npx playwright install chromium`) and its own `CRAWLER_SECRET`. Agent shell operations must prefix commands with `rtk proxy`, per `AGENTS.md`.

## Commands and verification

| Command                                   | Purpose                                                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                             | Development server with reload                                                                                                                                                                                       |
| `npm run lint`                            | ESLint, including explicit-any prohibition                                                                                                                                                                           |
| `npm run typecheck`                       | Strict TypeScript across apps/packages/tests                                                                                                                                                                         |
| `npm run format` / `npm run format:check` | Prettier write/check                                                                                                                                                                                                 |
| `npm test`                                | Deterministic unit tests; no network/database required, but **needs Chromium installed** (`npx playwright install chromium`) — the crawler policy tests launch a real browser and fail, rather than skip, without it |
| `npm run db:generate`                     | Generate migration from schema changes                                                                                                                                                                               |
| `npm run db:migrate`                      | Apply migrations and enable pgvector                                                                                                                                                                                 |
| `npm run worker`                          | pg-boss worker: scheduled scans, evaluation, alerts, digest, cleanup                                                                                                                                                 |
| `npm run crawler`                         | Isolated browser crawler/captured-API service (`apps/crawler`); needs Chromium and its own `CRAWLER_SECRET`                                                                                                          |
| `npm run build` / `npm start`             | Production build/start                                                                                                                                                                                               |
| `npm exec playwright install chromium`    | Install browser test runtime, required by `npm test` and `npm run crawler` too                                                                                                                                       |
| `npm run test:e2e`                        | Real PostgreSQL/API and browser integration suite                                                                                                                                                                    |
| `npm audit --audit-level=moderate`        | Dependency vulnerability check                                                                                                                                                                                       |

### Discovery configuration

Open **Discovery** and add a global feed: **RemoteOK**, **Jobicy**, **Remotive**, **The Muse**, **Himalayas**, **We Work Remotely**, **USAJOBS** or **Adzuna**. Each reads its provider's current listings across employers, so none needs a company name, board name or search URL. Their rolling feeds are never treated as a complete inventory, and Jobicy is refreshed at most once per hour per the provider's published terms. **USAJOBS** needs `USAJOBS_API_KEY` and `USAJOBS_EMAIL`, and **Adzuna** needs `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`, in `.env.local`; without them a scan fails with a message naming the missing variables. Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters and Rippling instead read one named employer board and require that board's identifier; JSON-LD requires an HTTPS page on a host listed in `JSON_LD_ALLOWED_HOSTS` in `.env.local`.

Click **Sync jobs** in the portal header to scan all enabled global feeds, or use **Sync source** beside one in Discovery. The portal scans feeds sequentially, continues after provider failures, refreshes results, and shows progress, import counts, partial results and source messages. The latest scan is shown even when it failed. Concurrent scans in the same workspace are rejected to avoid duplicate imports.

Keep the tab open until the sync finishes; you can navigate within the workspace while it runs. Each source runs synchronously in the request path, so large boards can take time and closing the tab may interrupt the current scan. Use a schedule instead when you want the worker to refresh a source without you watching it.

### Scheduling, watchlists, alerts and the digest

Set each source's refresh schedule on the **Automation** page, or by adding a company to the **Watchlist** with a Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters or Rippling board and choosing a schedule there. Schedules are Manual, Hourly, Every 4 hours, Twice daily or Daily, and they run on aligned UTC boundaries: a restart cannot double-run a slot, and a slot missed while the worker was down collapses into one run. The Automation page shows each source's next run, its last result and the recorded search history, and reports "Not running" when no recent worker heartbeat exists.

**Watchlist** entries carry your own priority (Dream Company, High Priority, Interesting, Neutral, Avoid). An entry that names a supported board owns the employer source the worker scans on its schedule, so that company is checked directly even when it never appears on a public feed. Removing an entry disables that source rather than deleting its provenance.

**Alerts** are opt-in in Preferences: choose an alert score and an evaluated match at or above it creates one in-app alert, deduped per evaluation so re-reading or re-running never repeats it. The unread bell in the header opens **Notifications**, where you can mark one or all as read. **Nothing is emailed, messaged or pushed.**

The **daily digest** is also opt-in and runs during a UTC hour you choose, or on demand from the Automation page. Its counts, ordering and highlights are computed deterministically from stored scores; only the summary sentence is a model call, and the digest still generates with deterministic text when OpenAI is unavailable. A digest is stored as an in-app notification with one record per UTC hour.

Housekeeping runs hourly in the worker and removes expired sessions, expired rate-limit buckets and read notifications older than 90 days. To see exactly what the worker did, follow its structured logs: `npm run worker` on the host or `docker compose logs -f worker` in Compose.

### Keyword filters and archiving

In **Preferences**, _Required keywords for importing_ and _Keywords that block importing_ control what discovery is allowed to import. Matching is case-insensitive and whitespace-insensitive, and each entry is matched against the listing title, company and description. A listing is imported only when it mentions at least one required keyword, and it is skipped when it contains any blocking keyword — an exclusion always wins, even when a required keyword also matches. Leave the required list empty to import every listing. The same keyword lists never affect the match score: scoring stays semantic, so a good role is not rejected for wording alone.

Each scan records how many listings the keyword rules skipped: the sync summary reports them as "skipped by your keyword filters", the source messages list a matching warning, and each source row shows a `filtered` count on **Discovery**. Skipped listings are never inserted, and listings you imported before adding a keyword are left untouched rather than deleted, so you decide what to keep. Archive the ones you no longer want.

**Archived opportunities** — reachable from the sidebar or the archive button in any list — are excluded from the dashboard counts, saved/application counts, list views, filters and automatic evaluation. Archiving keeps the row, its source provenance and its canonical URL/hash, so a later sync finds the existing record instead of importing that posting again. Restore an archived opportunity from the archive view or its detail page and it returns to every count and to automatic evaluation. Status, notes and timeline history are preserved while archived. Manual entries are never keyword-filtered, because you added them deliberately.

For the decisions, observed live-feed results and known limitations, see [keyword filters and archiving](doc/keyword-filters-and-archiving.md).

### AI matching configuration

Set `OPENAI_API_KEY` in ignored `.env.local`. `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`; `OPENAI_EXPLANATION_MODEL` defaults to `gpt-5.4-mini`. Open a job, choose **Evaluate match**, or let the portal evaluate a batch after each sync. Preferences control that batch: automatic evaluation can be turned off, the limit defaults to 5 jobs and accepts 1-20, and each sync evaluates at most that many eligible new or changed jobs one at a time. The evaluator receives only profile/preferences/listing evidence, has no tools, and cannot submit applications. Hard requirements — including your selected countries — are checked first and no score is persisted when OpenAI is unavailable or returns invalid JSON. The default monthly budget is USD 0.25; change it in Preferences. This is an estimate check, not a billing cap: it sums the latest successful evaluation per job, so re-evaluations overwrite previous usage, failed requests can incur unrecorded charges, and concurrent requests do not reserve budget. Prices are fixed to the default models; model overrides do not adjust prices or embedding dimensions. An append-only usage ledger and atomic reservations remain follow-up work.

For the full command matrix, observed results, opt-in live tests and limitations, see [Phase 3 validation](doc/phase-3-validation.md) and [Phase 4 validation](doc/phase-4-validation.md).

For integration/E2E tests, start PostgreSQL, migrate and build first. Playwright starts the production server unless one is already running at localhost:3000. Stop Compose web (`docker compose stop web`) before testing a host build to avoid silently testing an older container. Tests create unique `@example.test` accounts and synthetic jobs/resumes; use a disposable test database if you do not want those records in your development database. `DATABASE_URL` selects the test database; the app must use the same URL. For custom configuration, load it into the test process with `node --env-file=.env.local node_modules/@playwright/test/cli.js test`; plain `npm run test:e2e` only loads that file in the host web server. Snapshots/traces go into ignored `test-results/`.

`tests/e2e/crawler.spec.ts` needs a running crawler reachable at `CRAWLER_URL` (default `http://localhost:4000`) with the matching `CRAWLER_SECRET` (default `local-development-only`). Its fixture serves an HTTPS origin at `host.docker.internal` with a self-signed certificate, which production's own address checks correctly refuse — so the crawler must run with the test-only overlay `compose.e2e.yaml`, never with `compose.yaml` alone:

```sh
docker compose build crawler worker web
docker compose -f compose.yaml -f compose.e2e.yaml up -d --wait --build crawler
docker compose up -d
npx playwright test tests/e2e/crawler.spec.ts tests/e2e/companies.spec.ts
```

`compose.e2e.yaml` is never used outside a test run: it is what publishes the crawler's port, relaxes TLS verification for both Chromium (`CRAWLER_INSECURE_TLS`) and Node's own `fetch` (`NODE_TLS_REJECT_UNAUTHORIZED`), allowlists the one test hostname (`CRAWLER_INSECURE_TEST_HOSTNAME`) the fixture uses, and overrides `NODE_ENV` off `production` so those three variables can take effect at all — `apps/crawler/src/policy.ts` and `session.ts` refuse all three outright unless `NODE_ENV` is an explicit, known non-production value. `compose.yaml`'s `crawler` service has no `env_file`, so `.env.local` cannot reach it at all (that removal is also why the service never receives `DATABASE_URL`/`OPENAI_API_KEY`); this overlay is the only configuration path to any of the three insecure variables, in production or otherwise. `--wait` blocks until the crawler's unauthenticated `/health` endpoint reports healthy (the same endpoint `tests/e2e/crawler.spec.ts` checks first, to fail loudly rather than pass quietly against the wrong process on `CRAWLER_URL`).

Unit tests cover password verification, exact origin checks, bounded bodies, canonical URLs, weight validation, keyword import gates, qualification/interest scoring, hard filters, strict AI schemas, OpenAI response validation and cost estimation, UTC schedule alignment, recommendation bands, watchlist keys, alert dedupe identity and preference defaults, and real TXT/PDF/DOCX parsing including malformed/oversized/compressed input. API/database tests verify hashed credentials/sessions, revocation, rate limits, foreign keys, pgvector, hard-filter precedence, archiving scope, source ownership, watchlist scoping, worker scan idempotency, alert and digest idempotency, source schedules and expired-row cleanup. Browser tests verify profile/preferences, resume ownership, private jobs, saved-state/history, archive and restore counts, filtering, mobile overflow, theme and sign-in/out.

GitHub Actions runs formatting, lint, types, unit tests, migrations, dependency scanning, build, database/browser tests and container build. Deployment is deferred until an environment is configured.

## Structure

```text
apps/web/              UI, authenticated routes, application services
apps/worker/           pg-boss worker: scheduled scans, evaluation, alerts, digest, cleanup
apps/crawler/          Isolated Playwright crawler and captured-API service; no DB credentials, no published port
packages/automation/   Scan/evaluation/watchlist/alert/digest services shared by web and worker
packages/db/           Drizzle schema, generated SQL, migration runner
packages/shared/       Zod contracts and editable defaults
packages/job-sources/  Official ATS/feed adapters and bounded transport
packages/matching/     Embeddings, validation, scoring and OpenAI client
tests/unit/            Deterministic domain/security/parser tests
tests/e2e/             Real API/database and browser tests
doc/                   Requirements, architecture and phased plan
```

## Local foundation limitations

Before a public deployment: verified email/password recovery or external identity/MFA, trusted-proxy-aware edge throttling, HTTPS, least-privilege DB roles, private encrypted storage/backups, retention/export/deletion policy, isolated parsing with CPU/memory limits, and a security review. Local resumes are access-controlled database records, not application-encrypted documents. The app-wide auth throttle limits expensive hashing but can affect other users. Scheduled cleanup of expired sessions and rate-limit entries runs hourly in the worker, so it only happens while the worker is running. Scheduled work is not clustered: one worker per database is the supported local deployment.

Manual jobs belong to their author; future approved connector jobs may be shared. Descriptions are escaped text, never trusted HTML. Unknown salary/seniority/location stay unknown; score filtering excludes unevaluated jobs. Hard preferences block evaluation but do not hide the listing. Timeline/count dates use UTC. The theme toggle applies to the current browser document.

The dev-only Drizzle transitive esbuild dependency is overridden to a patched 0.25 release; migration generation is verified against that override. Infrastructure-as-code is deferred as requested.

## Company import and live activity

Open **Companies** (or **Watchlist**) and enter only the company name and its website or careers URL. **Bulk import** accepts a CSV/text file, tab-separated spreadsheet rows, or pasted domains. Use `name,domain` or `company,url` columns; a domain alone uses the domain as the display name. Up to 500 organizations and 150 KB per UI import are accepted. Results show queued, duplicate and rejected rows with line numbers. Supplied careers paths are preserved, and duplicate hosts (ignoring `www`) are skipped per user.

The worker picks up queued companies on its next minute tick. It checks robots.txt, follows bounded public HTTPS redirects, finds careers links, and identifies Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters and Rippling APIs. When a careers hub has no ATS or structured listings, it checks up to three linked department pages for a supported API before choosing AI fallback. Otherwise it reads JobPosting JSON-LD, then uses the configured OpenAI model to extract careers navigation and postings from fetched page text. Each proposed URL must have appeared in the page evidence; extracted titles, descriptions and locations must be supported by that text. The model cannot execute tools or submit applications. Resolved sources get a first scan immediately due and then refresh every four hours; change schedules under **Automation**.

**Live activity** on Companies, Watchlist and Automation refreshes every two seconds. It records website/robots requests, HTTP outcomes, source selection, AI extraction, imports, filtering, scan results, evaluation/alerts, digests and worker lifecycle events. Company and scan state survive a reload. Automation also refreshes heartbeat and run counters. Errors stay visible; Retry discovery requeues a failed company. Removing a company disables its source. Private activity is owner-scoped; shared events contain only generic worker lifecycle/maintenance information. Activity is retained for 90 days.

Custom careers extraction is bounded to 10 pages, four AI calls and 100 postings per scan. It reads HTTP page content; login walls and CAPTCHAs are not bypassed. Unsupported layouts report a visible failure, and capped walks report Partial. Custom careers scans never mark old listings removed because the full inventory cannot be proven. A missing AI key or unavailable robots policy is a visible failure.

When no ATS or JSON-LD is found and the `crawler` service is configured, discovery asks it to watch the careers page for a JSON API it calls; a replayable pattern is saved (`crawl_patterns`) and later scans replay that request over plain HTTP, no browser required. When nothing is replayable, the crawler instead walks the careers page itself (bounded pages/postings, `robots.txt` honoured, third-party hosts and non-public addresses refused, no CAPTCHA solving — a challenge page ends the session). Only when the crawler is unavailable or fails does discovery fall back to the AI extraction path above. `packages/discovery`'s ATS detection and company intake are complete; only the described fallback ordering and its two crawler rungs are new here.

Each AI extraction call records a conservative $0.05 estimate, including failures, against the existing monthly preference budget and stored match estimates. This assumes default model pricing and is **not a hard billing cap** or actual token accounting. The existing key and `OPENAI_EXPLANATION_MODEL` are reused. Tests inject website and model fixtures; they make no paid calls.

For changed code, rebuild both local services with `docker compose up --build -d --wait`; `restart` alone does not rebuild an image. See [company discovery validation](doc/company-discovery-validation.md).
