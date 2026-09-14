# Phase 1 validation

Validated locally on 2026-09-14 using Node 24, PostgreSQL 16 + pgvector, and Chromium. This is the foundation phase; discovery, semantic evaluation and automation remain planned in `architecture.md`.

## Completed checks

- `npm run lint`: passed with no warnings.
- `npm run typecheck`: passed.
- `npm run format:check`: passed.
- `npm test`: 14 deterministic tests passed, including real generated PDF/DOCX fixtures, password hashing, invalid uploads and score validation.
- `npm run db:generate`: no schema drift after initial generated migration; verified with patched esbuild override.
- `npm run db:migrate`: applied successfully; subsequent Compose migration succeeded on the existing database.
- `npm audit`: zero known vulnerabilities in production and development dependency graph at validation time.
- `npm run build`: passed, including all application routes.
- `npm run test:e2e`: 3 tests passed against the host build and again against the final Compose web container. Covers browser workflow, cross-account document/job isolation, preferences/profile persistence, status notes, filtering, mobile overflow, theme, sign-in/out, hashed DB sessions, revocation, FK constraints, pgvector and authentication rate limits.
- `docker compose up --build -d --wait`: successful; web and PostgreSQL healthy, migration container exited successfully. App is available on loopback port 3000.
- `git diff --check`: passed. Environment files, node_modules and test results are ignored.

## Visual review

Reviewed desktop light/dark and 390px mobile dashboard screenshots. Fixed an absolutely positioned screen-reader table label escaping its scroll container and a registration password label that included help text in its accessible name. The mobile table scrolls within the panel. Screenshots are local, ignored artifacts at `test-results/dashboard-desktop.png`, `test-results/dashboard-dark.png`, and `test-results/dashboard-mobile.png`; generated job and account data in screenshots are fictional test fixtures.

## Remaining boundaries

- OpenAI key creation has been requested but the secure picker has not returned a confirmed project selection. No OpenAI key was created or exposed, and no AI requests were made.
- Resume extraction is local plain text extraction with manual structured profile editing, not AI extraction or OCR.
- No live ATS connector, semantic score generation, scheduler, alert delivery or deployment exists yet. Manual listings and private tracking work against PostgreSQL.
- Public production deployment requires the authentication, storage, document-isolation and operational hardening described in `README.md` and `architecture.md`.
- CI workflow is present and its local commands have been verified; the hosted GitHub Actions run has not been triggered in this session.
- Local tests created synthetic `@example.test` accounts in the development database; no real resume data or preconfigured user account was installed.
