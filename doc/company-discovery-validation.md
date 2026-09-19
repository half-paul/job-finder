# Company intake, discovery and activity validation

Date: 2026-09-16

Implemented:

- Two-field company intake and CSV/TSV/text bulk import with up to 500 organizations, per-row rejections, per-user duplicate handling, preserved website paths and queued persistence.
- Owner-scoped company list, retry, removal and activity APIs with authentication, Origin validation, bounded bodies, Zod validation and import/retry rate limits.
- Durable `resolve-company` worker queue with atomic claims, attempt fencing, stale recovery, persisted discovery decisions, linked watchlist/source and immediately due first scan.
- Careers links and common paths, supported ATS API detection, JSON-LD first, bounded AI extraction fallback using the existing OpenAI configuration. Custom extraction applies existing keyword import gates and never marks removals.
- Live persistent activity across the application and worker, scan counters during processing, failure details, heartbeat, refresh and older-event loading.
- Migration `0007_true_speedball.sql`: `activity_events` and `company_candidates.website_url`.
- Migration `0008_loose_silver_centurion.sql`: indexes on the four foreign keys that cascade or null out on delete.

Verification performed:

- `npm run db:generate` and `npm run db:migrate`: generated and applied migrations `0007_true_speedball.sql` and `0008_loose_silver_centurion.sql`.
- `npm run build`: production build succeeded.
- `npm test`: 137 tests passed, including unavailable-robots policy rejection.
- `npx playwright test`: 28 passed, 3 opt-in live tests skipped, using real PostgreSQL and the built host application, with Compose web/worker stopped to avoid old-code tests and live scheduling. This includes the persisted AI budget estimate and refusal of another call after the estimate reaches the configured budget.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, and `git diff --check`: passed.
- `docker compose up --build -d --wait`: rebuilt and started web/worker successfully; migrations exited successfully, `/api/health` returned `{"status":"ok"}`, and worker logs confirmed all five queues including `resolve-company`. Existing OpenAI key presence in the worker was checked without exposing its value.
- The integration tests exercise origin checks, owner isolation, bulk duplicates, worker ATS discovery, fixture API scan, activity persistence, deletion disabling a source, concurrent claims, stale recovery, robots blocking, retry and AI fallback with injected output.
- Browser verification covers two-field intake, CSV upload, queued state, live activity and reload persistence. Desktop and 390px mobile screenshots were inspected: `test-results/company-workflow-desktop.png` and `test-results/company-workflow-mobile.png` (generated, ignored artifacts).

Review fixes applied before landing:

- `deleteWatchlist` now removes candidates, the entry and the source schedule in one transaction, matching `deleteCompany`.
- Bulk import runs as one transaction with set-based writes instead of one transaction per row, and per-listing scan progress is buffered and flushed in batches of 50.
- The company list reads a bounded page, and the activity feed stops polling hidden tabs and backs off while the endpoint is failing.
- The watchlist "Scan all" button used an undefined CSS class and the per-row scan control used the icon-only `.icon-button` box; both now use defined styles.

Boundaries:

- No live connector or paid model tests were run. Website and AI calls in tests are injected fixtures.
- API detection supports Greenhouse, Lever and Ashby; recognition of another ATS does not claim its API is supported. Captured API replay and an isolated browser service remain unfinished scaffolding.
- Custom scraping reads HTTP content; JavaScript-only sites, inaccessible sites, robots refusals, unavailable robots policies, login walls and unsupported layouts surface errors. No CAPTCHA/authentication bypass.
- Custom extraction caps each scan at ten pages, four model calls and 100 postings; capped walks are Partial. The model receives bounded page evidence and no tools or credentials, and output is schema/evidence validated before persistence.
- Per-call AI cost accounting is a conservative $0.05 estimate based on default pricing, retained even for a failed call. It participates in the existing monthly estimate check, not a hard billing cap. Configured alternative model pricing and actual token reconciliation remain open.
- Activity retention is 90 days. Shared activity contains only generic worker lifecycle/maintenance events; private candidate, source, job and evaluation activity is owner-scoped.
- Existing unrelated working-tree changes were preserved. Adjacent incomplete discovery helper type errors and an unsupported manual-provider schema were corrected to keep the application buildable and prevent unsupported source configuration.

The structured extraction request follows the [OpenAI Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs), with strict JSON Schema and explicit refusal/truncation handling.
