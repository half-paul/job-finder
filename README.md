# JobFinder AI

A private career workspace for collecting opportunities and defining what your next role should look like. See the [requirements](doc/AI%20Job%20Finder%20Web%20App%20-%20requirements.md), [architecture and phased plan](doc/architecture.md), [Phase 2 validation](doc/phase-2-validation.md), [Phase 3 validation](doc/phase-3-validation.md), and [keyword filters and archiving](doc/keyword-filters-and-archiving.md).

## Implemented: Phase 1 foundation + Phase 2 discovery + Phase 3 matching

- Next.js App Router, React, strict TypeScript, Tailwind and accessible Radix/variant-based UI primitives.
- PostgreSQL 16 with pgvector, Drizzle schema and checked-in migrations.
- Email/password accounts, scrypt hashing, opaque database sessions, logout, CSRF origin checks and database-backed authentication/upload rate limits.
- Private structured profiles; configurable target roles/groups, weighted skills, location, work, seniority, compensation and ranking preferences.
- Private TXT, text-based PDF and DOCX upload, local text extraction, original download and deletion. Up to 10 documents per account, 5 MiB each. Scanned PDFs need OCR first.
- Dashboard, live search/work/score filters, pagination, saved jobs, application status, detail pages, private notes and status history. Manual job entry makes the workspace usable before discovery connectors arrive.
- Responsive layout, keyboard-accessible controls, light/dark toggle, empty states and explicit unevaluated matches.
- Multi-employer RemoteOK and Jobicy feeds for cross-company discovery. Global feeds need only a provider; no company, board or search URL. Greenhouse, Lever, Ashby and allowlisted JSON-LD `JobPosting` pages remain available as employer-specific connectors.
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

Discovery is user-triggered and feeds each provider's current listings; automatic evaluation then runs one bounded batch. Scheduled searches, notifications and application-writing assistance are **not implemented yet**. The app does not submit applications. Indeed has no supported public job API and is not connected. No sample jobs or shared-password accounts are installed. The profile editor can load an explicitly labeled fictional executive example into the form for review.

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

The web container optionally reads ignored `.env.local` for AI models/key and the JSON-LD allowlist. Compose overrides `DATABASE_URL` and `APP_ORIGIN` with its local container settings. After changing `.env.local`, run `docker compose up -d --force-recreate web`. The environment file is excluded from image builds.

No Redis or idle worker is included. The planned pg-boss worker arrives with background discovery.

## Develop on the host

Requires Node.js 22+ (Node 24 in Docker/CI), npm and Docker.

```sh
npm ci
cp .env.example .env.local
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Do not overwrite an existing `.env.local`; add only missing configuration. Root `.env.local` is loaded by development, start and migration commands and ignored by Git/Docker. `DATABASE_URL` is required; `APP_ORIGIN` must exactly match the browser origin for writes. The default is `http://localhost:3000`, not `127.0.0.1`. Secure cookies are enabled for HTTPS origins. `OPENAI_API_KEY` is required only for AI evaluation; the rest of the workspace runs without it. Agent shell operations must prefix commands with `rtk proxy`, per `AGENTS.md`.

## Commands and verification

| Command                                   | Purpose                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `npm run dev`                             | Development server with reload                         |
| `npm run lint`                            | ESLint, including explicit-any prohibition             |
| `npm run typecheck`                       | Strict TypeScript across apps/packages/tests           |
| `npm run format` / `npm run format:check` | Prettier write/check                                   |
| `npm test`                                | Deterministic unit tests; no network/database required |
| `npm run db:generate`                     | Generate migration from schema changes                 |
| `npm run db:migrate`                      | Apply migrations and enable pgvector                   |
| `npm run build` / `npm start`             | Production build/start                                 |
| `npm exec playwright install chromium`    | Install browser test runtime                           |
| `npm run test:e2e`                        | Real PostgreSQL/API and browser integration suite      |
| `npm audit --audit-level=moderate`        | Dependency vulnerability check                         |

### Discovery configuration

Open **Discovery** and add **RemoteOK** or **Jobicy**. Both read their provider's current listings across employers, so they need no company name, board name or search URL. Their rolling feeds are never treated as a complete inventory, and Jobicy is refreshed at most once per hour per the provider's published terms. Greenhouse, Lever and Ashby instead read one named employer board and require that board's identifier; JSON-LD requires an HTTPS page on a host listed in `JSON_LD_ALLOWED_HOSTS` in `.env.local`.

Click **Sync jobs** in the portal header to scan all enabled global feeds, or use **Sync source** beside one in Discovery. The portal scans feeds sequentially, continues after provider failures, refreshes results, and shows progress, import counts, partial results and source messages. The latest scan is shown even when it failed. Concurrent scans in the same workspace are rejected to avoid duplicate imports.

Keep the tab open until the sync finishes; you can navigate within the workspace while it runs. Each source runs synchronously, so large boards can take time. Reloading or closing the tab stops dispatching further sources and may interrupt the current scan; resumable background scans arrive with Phase 4.

### Keyword filters and archiving

In **Preferences**, _Required keywords for importing_ and _Keywords that block importing_ control what discovery is allowed to import. Matching is case-insensitive and whitespace-insensitive, and each entry is matched against the listing title, company and description. A listing is imported only when it mentions at least one required keyword, and it is skipped when it contains any blocking keyword — an exclusion always wins, even when a required keyword also matches. Leave the required list empty to import every listing. The same keyword lists never affect the match score: scoring stays semantic, so a good role is not rejected for wording alone.

Each scan records how many listings the keyword rules skipped: the sync summary reports them as "skipped by your keyword filters", the source messages list a matching warning, and each source row shows a `filtered` count on **Discovery**. Skipped listings are never inserted, and listings you imported before adding a keyword are left untouched rather than deleted, so you decide what to keep. Archive the ones you no longer want.

**Archived opportunities** — reachable from the sidebar or the archive button in any list — are excluded from the dashboard counts, saved/application counts, list views, filters and automatic evaluation. Archiving keeps the row, its source provenance and its canonical URL/hash, so a later sync finds the existing record instead of importing that posting again. Restore an archived opportunity from the archive view or its detail page and it returns to every count and to automatic evaluation. Status, notes and timeline history are preserved while archived. Manual entries are never keyword-filtered, because you added them deliberately.

For the decisions, observed live-feed results and known limitations, see [keyword filters and archiving](doc/keyword-filters-and-archiving.md).

### AI matching configuration

Set `OPENAI_API_KEY` in ignored `.env.local`. `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`; `OPENAI_EXPLANATION_MODEL` defaults to `gpt-5.4-mini`. Open a job, choose **Evaluate match**, or let the portal evaluate a batch after each sync. Preferences control that batch: automatic evaluation can be turned off, the limit defaults to 5 jobs and accepts 1-20, and each sync evaluates at most that many eligible new or changed jobs one at a time. The evaluator receives only profile/preferences/listing evidence, has no tools, and cannot submit applications. Hard requirements — including your selected countries — are checked first and no score is persisted when OpenAI is unavailable or returns invalid JSON. The default monthly budget is USD 0.25; change it in Preferences. This is an estimate check, not a billing cap: it sums the latest successful evaluation per job, so re-evaluations overwrite previous usage, failed requests can incur unrecorded charges, and concurrent requests do not reserve budget. Prices are fixed to the default models; model overrides do not adjust prices or embedding dimensions. An append-only usage ledger and atomic reservations remain follow-up work.

For the full command matrix, observed results, opt-in live tests and limitations, see [Phase 3 validation](doc/phase-3-validation.md).

For integration/E2E tests, start PostgreSQL, migrate and build first. Playwright starts the production server unless one is already running at localhost:3000. Stop Compose web (`docker compose stop web`) before testing a host build to avoid silently testing an older container. Tests create unique `@example.test` accounts and synthetic jobs/resumes; use a disposable test database if you do not want those records in your development database. `DATABASE_URL` selects the test database; the app must use the same URL. For custom configuration, load it into the test process with `node --env-file=.env.local node_modules/@playwright/test/cli.js test`; plain `npm run test:e2e` only loads that file in the host web server. Snapshots/traces go into ignored `test-results/`.

Unit tests cover password verification, exact origin checks, bounded bodies, canonical URLs, weight validation, keyword import gates, qualification/interest scoring, hard filters, strict AI schemas, OpenAI response validation and cost estimation, and real TXT/PDF/DOCX parsing including malformed/oversized/compressed input. API/database tests verify hashed credentials/sessions, revocation, rate limits, foreign keys, pgvector, hard-filter precedence, archiving scope and source ownership. Browser tests verify profile/preferences, resume ownership, private jobs, saved-state/history, archive and restore counts, filtering, mobile overflow, theme and sign-in/out.

GitHub Actions runs formatting, lint, types, unit tests, migrations, dependency scanning, build, database/browser tests and container build. Deployment is deferred until an environment is configured.

## Structure

```text
apps/web/              UI, authenticated routes, application services
packages/db/           Drizzle schema, generated SQL, migration runner
packages/shared/       Zod contracts and editable defaults
packages/job-sources/  Official ATS/feed adapters and bounded transport
packages/matching/     Embeddings, validation, scoring and OpenAI client
tests/unit/            Deterministic domain/security/parser tests
tests/e2e/             Real API/database and browser tests
doc/                   Requirements, architecture and phased plan
```

## Local foundation limitations

Before a public deployment: verified email/password recovery or external identity/MFA, trusted-proxy-aware edge throttling, HTTPS, least-privilege DB roles, private encrypted storage/backups, retention/export/deletion policy, isolated parsing with CPU/memory limits, and a security review. Local resumes are access-controlled database records, not application-encrypted documents. The app-wide auth throttle limits expensive hashing but can affect other users. Expired sessions/rate-limit entries need scheduled cleanup in Phase 4.

Manual jobs belong to their author; future approved connector jobs may be shared. Descriptions are escaped text, never trusted HTML. Unknown salary/seniority/location stay unknown; score filtering excludes unevaluated jobs. Hard preferences block evaluation but do not hide the listing. Timeline/count dates use UTC. The theme toggle applies to the current browser document.

The dev-only Drizzle transitive esbuild dependency is overridden to a patched 0.25 release; migration generation is verified against that override. Infrastructure-as-code is deferred as requested.
