# Repository Guidelines

## Project Structure & Module Organization

JobFinder AI is currently a documentation-only repository. `README.md` identifies the project; `doc/AI Job Finder Web App - requirements.md` defines its scope, architecture, and implementation phases. No source code, tests, or application assets exist yet.

The requirements propose `apps/web` for Next.js, `apps/worker` for background processing, shared packages under `packages/` (database, AI, job sources, matching, and shared types), and `infrastructure/terraform` for cloud infrastructure. These directories are planned, not implemented. Keep current planning documents in `doc/`.

## Build, Test, and Development Commands

No package manifest, build scripts, test runner, or Docker Compose configuration is present. Do not assume `npm test` or `npm run build` works. When scaffolding the application, document exact installation, development, lint, typecheck, test, and build commands in `README.md`.

The intended local deployment command is `docker compose up`, once Compose configuration exists.

For agent shell operations, follow `/Users/paul/.codex/RTK.md`: prefix commands with `rtk`, using `rtk proxy <command>` when raw execution is needed. Examples: `rtk git status --short` and `rtk proxy rg --files`.

## Coding Style & Naming Conventions

The planned stack uses strict TypeScript, ESLint, Prettier, and Zod validation; none is configured yet. Establish formatting settings with the initial scaffold, using two-space indentation for TypeScript and JSON. Use PascalCase for components and types, and camelCase for functions and variables. Avoid `any`, validate external data, and keep business logic outside UI components.

## Testing Guidelines

No testing framework or coverage threshold is configured. Planned coverage includes unit, integration, connector, API, database, matching, and Playwright end-to-end tests. Add deterministic ATS fixtures so connector tests do not require live websites. Establish test naming and runnable commands alongside the first implementation.

## Commit & Pull Request Guidelines

Git history contains only `first commit`; no established message convention exists. Use concise, imperative subjects, such as `Add source connector interface`. Keep changes focused. PRs should explain the change, reference relevant requirements or issues, report validation performed, and include screenshots for UI changes.

## Security & Configuration

Keep credentials and real resumes out of Git. Use environment variables locally and a production secret manager. Treat retrieved job content as untrusted data; prefer permitted APIs and structured feeds, and respect source access restrictions.
