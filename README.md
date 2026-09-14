# JobFinder AI

A private career workspace for collecting opportunities and defining what your next role should look like. See the [requirements](doc/AI%20Job%20Finder%20Web%20App%20-%20requirements.md), [architecture and phased plan](doc/architecture.md), and [Phase 2 validation](doc/phase-2-validation.md).

## Implemented: Phase 1 foundation + Phase 2 discovery

- Next.js App Router, React, strict TypeScript, Tailwind and accessible Radix/variant-based UI primitives.
- PostgreSQL 16 with pgvector, Drizzle schema and checked-in migrations.
- Email/password accounts, scrypt hashing, opaque database sessions, logout, CSRF origin checks and database-backed authentication/upload rate limits.
- Private structured profiles; configurable target roles/groups, weighted skills, location, work, seniority, compensation and ranking preferences.
- Private TXT, text-based PDF and DOCX upload, local text extraction, original download and deletion. Up to 10 documents per account, 5 MiB each. Scanned PDFs need OCR first.
- Dashboard, live search/work/score filters, pagination, saved jobs, application status, detail pages, private notes and status history. Manual job entry makes the workspace usable before discovery connectors arrive.
- Responsive layout, keyboard-accessible controls, light/dark toggle, empty states and explicit unevaluated matches.
- Official Greenhouse, Lever, Ashby and RemoteOK connectors plus allowlisted JSON-LD `JobPosting` pages.
- Hardened source transport: HTTPS only, fixed public hosts, no redirects, DNS pinning against rebinding, public-address checks, response-size and timeout limits.
- Provider-specific validation and normalization with unknown values left explicit, HTML converted to bounded plain text, and complete-feed caching to avoid duplicate source requests.
- Private source management and user-triggered complete scans. Imports preserve provider/external IDs and source URLs, upsert changed descriptions idempotently, and mark jobs removed only after a complete scan no longer sees them.
- Search diagnostics record seen/added/changed/removed counts and per-job warnings without aborting the rest of a scan.

Discovery is user-triggered rather than scheduled. Semantic matching, AI explanations, scheduled searches, notifications and application-writing assistance are **not implemented yet**. Phases 1-2 make no OpenAI calls and run without an API key. The app does not submit applications. No sample jobs or shared-password accounts are installed. The profile editor can load an explicitly labeled fictional executive example into the form for review.

Scans have a 5,000-job safety cap. A capped or cursor-incomplete scan is recorded as **Partial** and never marks older listings removed.

## Start with Docker

Install Docker with Compose and run from the repository:

```sh
docker compose up --build
```

Open **http://localhost:3000**, choose **Create an account**, and create your workspace. Compose starts PostgreSQL, applies migrations, and starts the built web app. Data persists in the `postgres-data` volume. Ports bind to loopback only. The database password is for local development; never reuse it for a public deployment.

```sh
docker compose stop     # stop, retaining data
docker compose up -d    # restart
```

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

Do not overwrite an existing `.env.local`; add only missing configuration. Root `.env.local` is loaded by development, start and migration commands and ignored by Git/Docker. `DATABASE_URL` is required; `APP_ORIGIN` must exactly match the browser origin for writes. The default is `http://localhost:3000`, not `127.0.0.1`. Secure cookies are enabled for HTTPS origins. External credentials remain server-side and are unnecessary for this phase. Agent shell operations must prefix commands with `rtk proxy`, per `AGENTS.md`.

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

Open **Discovery**, choose a provider, and enter the official board/site name plus a company label. RemoteOK uses its permitted feed and needs only the company label. JSON-LD sources require an HTTPS `JSON_LD_ALLOWED_HOSTS` allowlist in `.env.local`; arbitrary user URLs are never fetched. Scans run synchronously from the Discovery page, so large boards can take time; resumable background scans arrive with Phase 4.

For integration/E2E tests, start PostgreSQL, migrate and build first. Playwright starts the production server unless one is already running. Tests create unique `@example.test` accounts and synthetic jobs/resumes; use a disposable test database if you do not want those records in your development database. `DATABASE_URL` selects the test database; the app must use the same URL. Snapshots/traces go into ignored `test-results/`.

Unit tests cover password verification, exact origin checks, bounded bodies, canonical URLs, weight validation, qualification/interest scoring, and real TXT/PDF/DOCX parsing including malformed/oversized/compressed input. API/database tests verify hashed credentials/sessions, revocation, rate limits, foreign keys and pgvector. Browser tests verify profile/preferences, resume ownership, private jobs, saved-state/history, filtering, mobile overflow, theme and sign-in/out.

GitHub Actions runs formatting, lint, types, unit tests, migrations, dependency scanning, build, database/browser tests and container build. Deployment is deferred until an environment is configured.

## Structure

```text
apps/web/              UI, authenticated routes, application services
packages/db/           Drizzle schema, generated SQL, migration runner
packages/shared/       Zod contracts and editable defaults
packages/job-sources/  Connector interface (implementations: Phase 2)
packages/matching/     Score aggregation (semantic evaluation: Phase 3)
tests/unit/            Deterministic domain/security/parser tests
tests/e2e/             Real API/database and browser tests
doc/                   Requirements, architecture and phased plan
```

## Local foundation limitations

Before a public deployment: verified email/password recovery or external identity/MFA, trusted-proxy-aware edge throttling, HTTPS, least-privilege DB roles, private encrypted storage/backups, retention/export/deletion policy, isolated parsing with CPU/memory limits, and a security review. Local resumes are access-controlled database records, not application-encrypted documents. The app-wide auth throttle limits expensive hashing but can affect other users. Expired sessions/rate-limit entries need scheduled cleanup in Phase 4.

Manual jobs belong to their author; future approved connector jobs may be shared. Descriptions are escaped text, never trusted HTML. Unknown salary/seniority/location stay unknown; score filtering excludes unevaluated jobs. Hard-preference enforcement arrives in Phase 3 and is not implied by saving preferences today. Timeline/count dates use UTC. The theme toggle applies to the current browser document.

The dev-only Drizzle transitive esbuild dependency is overridden to a patched 0.25 release; migration generation is verified against that override. Infrastructure-as-code is deferred as requested.
