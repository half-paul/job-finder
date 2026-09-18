# JobFinder AI — architecture and delivery plan

Status: Phase 1–4 plus company intake, worker careers discovery, bounded HTTP/AI extraction and live activity. The requirements document remains the product specification. An empty database must never imply invented job listings or AI scores, and no alert, digest or scan result is fabricated while the worker is stopped.

## Architecture

Use a TypeScript workspace with Next.js App Router for UI and authenticated HTTP APIs, Drizzle for PostgreSQL 16, and pgvector for Phase 3 embeddings. A separate Node worker uses pg-boss for durable jobs, retries and scheduling in the database we already operate, without adding Redis. The web app and the worker share one service package (`packages/automation`); provider, matching and shared contracts stay independent of Next.js. Use Docker Compose for local deployment; defer AWS infrastructure.

```mermaid
flowchart TD
  Browser[Browser: executive dashboard] --> Web[Next.js: authentication and APIs]
  Web --> DB[(PostgreSQL 16 + pgvector)]
  Web --> Documents[Private resume records]
  Worker[Node worker: pg-boss] --> Sources
  Worker --> Evaluation
  Worker --> Alerts[Opt-in alerts and daily digest]
  Worker --> Maintenance[Cleanup and diagnostics]
  Worker --> DB
  Maintenance --> DB
  Alerts --> DB
  Worker --> Discovery[Company discovery and career URL finder, Phase 5]
  Discovery --> Detector[ATS detector: Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters, Rippling, Workday, custom]
  Detector --> Sources[Permitted ATS APIs and feeds, Phase 2]
  Detector --> Crawler[Isolated browser crawler and saved API patterns, Phase 5]
  Sources --> Extract[Job extractor: API payload, JSON-LD, HTML, bounded AI]
  Crawler --> Extract
  Extract --> Normalize[Location normalization, deduplicate, freshness]
  Normalize --> DB
  DB --> Filter[Hard constraints and inexpensive retrieval]
  Filter --> Embeddings[Embedding retrieval, Phase 3]
  Embeddings --> Evaluation[Bounded LLM evaluation]
  Evaluation --> DB
  DB --> Alerts
```

### Repository boundaries

- `apps/web`: Next.js pages, route handlers, server-only auth and application services, reusable UI.
- `packages/db`: typed schema, versioned SQL migrations, database connection and migration command.
- `packages/shared`: Zod input schemas, profile/preferences and job contracts.
- `packages/job-sources`: source connector contract; multi-employer RemoteOK, Jobicy, Remotive, The Muse, Himalayas, We Work Remotely, USAJOBS and Adzuna feeds plus employer-specific Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters, Rippling and allowlisted JSON-LD adapters.
- `packages/matching`: deterministic filters/aggregation, embedding client/cache contracts and structured AI evaluation.
- `packages/automation`: the server-side service layer shared by the web app and the worker — the source scan engine, the bounded evaluation batch, watchlists, alerts, the daily digest, schedule math, expired-row cleanup and automation diagnostics. It imports no Next.js code, so `apps/worker` reuses it unchanged.
- `packages/discovery` (Phase 5): company discovery, career URL finder, ATS detector, structured location normalizer and the discovery transport. Depends on `packages/job-sources` for connectors; never the reverse.
- `apps/worker`: the pg-boss process that owns scheduled scans, scheduled evaluation, alert creation, the daily digest and cleanup. It publishes no ports, and it is the only process that runs scheduled network work.
- `packages/ai`: reserved for later AI implementation, not an empty running service.
- `tests`: unit and real PostgreSQL/API/E2E verification. `doc`: decisions and plans.

## PostgreSQL schema

Use UUID primary keys and timezone-aware timestamps. Private records always carry a user foreign key. Every private read and write must scope by authenticated user; public job records can be shared. Prefer typed JSONB for evolving structured profile/preferences, while keeping searchable jobs relational.

| Table              | Important columns and constraints                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| users              | unique normalized email, password hash, name, role, created_at                                                                                     |
| sessions           | SHA-256 token hash PK, user_id FK, expiry; raw tokens only in HTTP-only cookies                                                                    |
| rate_limits        | hashed bucket key PK, count, expiry; atomic update shared across instances                                                                         |
| user_profiles      | user_id PK/FK, typed structured profile JSONB, updated_at                                                                                          |
| career_preferences | user_id PK/FK, typed preferences JSONB, updated_at                                                                                                 |
| resumes            | id, user_id, filename, MIME, original bytes encoded privately, extracted text, created_at                                                          |
| companies          | id, name, domain, optional industry/size/overview; Phase 5 adds careers_url, ats, ats_key, crawl_strategy, status, last_checked_at, next_check_at  |
| company_candidates | id, name, domain, origin (seed list, search, referral), status, created_at; Phase 5 input queue for career URL discovery                           |
| crawl_patterns     | id, company_id, kind (ats, json-ld, http-json, browser), url_template, request JSONB, discovered_at, last_verified_at; saved API patterns, Phase 5 |
| job_locations      | id, job_id, raw text, country, region, city, remote, applicant_countries[], confidence, evidence; Phase 5 structured location per posting          |
| job_sources        | id, owner_id, provider, unique owner/board identity, enabled, source URL, schedule, next_run_at, last_checked_at                                   |
| jobs               | id, company_id, title, description, employment/seniority/location, compensation, canonical URL/hash, lifecycle dates, archived_at and status       |
| job_references     | job_id + source_id + external_id; retain all provenance for deduplicated listings                                                                  |
| job_matches        | user_id + job_id PK, qualification/interest/overall scores, confidence, versioned explanation JSONB, evaluated_at                                  |
| saved_jobs         | user_id + job_id PK, action/status, notes, updated_at                                                                                              |
| job_status_history | id, user_id, job_id, action, created_at; append on every user action                                                                               |
| audit_events       | id, user_id, action, created_at; exclude sensitive payloads                                                                                        |
| search_runs        | id, source_id, user_id, status, trigger (Manual/Schedule), counters, warnings, error, duration_ms; the search history the diagnostics view reads   |
| company_watchlists | id, user_id, company + normalized company_key (unique per user), domain, provider/board, priority, notes, source_id; Phase 4 watchlist entries     |
| notifications      | id, user_id, optional job_id, kind (Match/Digest/System), title, body, score, unique user/dedupe_key, read_at, created_at                          |
| automation_state   | key PK, JSONB value, updated_at; worker heartbeat and the last scheduler/digest pass                                                               |

Keyword rules and archiving are deliberately cheap and deterministic, not AI work. `career_preferences.includeKeywords` gates discovery: a listing is imported only when it mentions at least one required keyword, and `negativeKeywords` blocks a listing outright. Rules are matched case-insensitively against title, company and description, exclusions always win, an empty required list imports everything, and keywords never influence the match score. `jobs.archived_at` marks a listing the user set aside: archived rows keep their canonical URL/hash and provenance, so a later sync re-uses the existing row instead of importing the posting again, while every list, count and automatic evaluation excludes it. Archived rows are restored in place, and manual entries are never gated by keywords because the user added them deliberately.

Scheduling and alerting are also deterministic. `job_sources.schedule` is one of Manual, Hourly, Every 4 hours, Twice daily or Daily, and `next_run_at` is always an aligned UTC instant computed by the shared `nextRunAfter` helper, so a restart cannot pile up duplicate refreshes and missed slots collapse into a single run. Watchlist entries are the user's own priority list; an entry that names a supported ATS board also owns the `job_sources` row the worker scans, so that employer is checked directly even when it never appears on a public feed. Alerts are opt-in in-app records keyed by user and a deterministic dedupe key, so replaying an evaluation or a digest never duplicates a notification. Nothing is emailed, messaged or pushed.

Later migrations add separate job_locations/job_skills indexes when filtering volume warrants them and detailed applications. Roles/skills and their priorities initially live in validated preferences JSONB. Profile data is stored separately from original resume content. Originals remain in private PostgreSQL storage for the local MVP; production moves them to encrypted object storage with short-lived authorized downloads and retention/deletion controls.

## API architecture

JSON errors use `{ error: string }` with meaningful HTTP status codes. Never return a password hash, session token, database error, or another user's resume. All mutations require a matching configured Origin (CSRF protection). Session expiry and authorization are checked in the data layer, not just page navigation.

| Endpoint                                               | Behavior                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| POST /api/auth/register, /login, /logout               | local email/password account, opaque DB session, rate limited           |
| GET/PUT /api/profile                                   | read/update validated private structured profile                        |
| GET/PUT /api/preferences                               | targets, weighted role groups, skills, hard filters and ranking weights |
| GET/POST /api/resumes                                  | metadata listing and bounded TXT/PDF/DOCX text extraction               |
| GET/DELETE /api/resumes/:id                            | owner-only original download and deletion                               |
| GET /api/jobs                                          | paginated query, location/work arrangement and saved-state filters      |
| GET /api/jobs/:id                                      | normalized listing and current user's evaluation/status                 |
| PUT /api/jobs/:id/status                               | save/ignore/application status, transactional history                   |
| PUT /api/jobs/:id/archive                              | archive or restore a listing without losing its canonical identity      |
| GET/POST /api/sources                                  | list feeds and add a global or employer source                          |
| POST /api/sources/:id                                  | user-triggered scan of one source, plus the bounded evaluation batch    |
| PUT /api/sources/:id/schedule                          | set a Manual/Hourly/4-hourly/twice-daily/daily refresh schedule         |
| GET/POST /api/watchlist, PUT/DELETE /api/watchlist/:id | watchlist entries, priorities and directly-scanned employer boards      |
| GET /api/notifications, POST /api/notifications/mark   | in-app alerts and mark-read, user scoped                                |
| GET /api/automation, POST /api/automation/digest       | worker health, source schedules, search history, on-demand digest       |
| GET /api/health                                        | database readiness without connection details                           |

Discovery uses GET/POST `/api/sources` and POST `/api/sources/:id`; matching uses POST `/api/jobs/:id/evaluate`, and the post-sync batch uses POST `/api/jobs/evaluation-batch`. No endpoints silently succeed without doing work.

## Connector contract and source policy

`SourceConnector` exposes `search(query, cursor, signal)`, `fetchJob(reference, signal)`, and `normalize(raw)`. Search returns a validated page plus continuation, conditional-fetch and removal-safety metadata. Board identity is configuration, never an arbitrary fetch URL. Normalized jobs retain provider, external ID, original URL, timestamps and unknown values explicitly. Discovery uses Greenhouse, Lever, Ashby, Workable, Personio, SmartRecruiters and Rippling board APIs, the RemoteOK, Jobicy, Remotive, The Muse, Himalayas, We Work Remotely, USAJOBS and Adzuna multi-employer feeds, and allowlisted JSON-LD pages.

Retrieval follows a fixed preference ladder: official ATS API, then Schema.org `JobPosting` JSON-LD, then plain HTTP fetch of a discovered JSON endpoint, then an isolated browser crawl, and only last a bounded AI-directed browser session. Each company records which rung it uses in `companies.crawl_strategy`, and a cheaper rung discovered later replaces a costlier one. The ATS detector recognises `boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`, `apply.workable.com`, `*.jobs.personio.de`, `*.jobs.personio.com`, `ats.rippling.com`, `*.myworkdayjobs.com`, `jobs.smartrecruiters.com`, `*.icims.com` and `*.taleo.net` from redirects, links, iframes and script requests, and stores `{ ats, ats_key }` so the matching connector runs without a browser. Discovery is a one-time cost per company; refreshes reuse the stored strategy until it fails.

Maintain a provider registry with approved hosts, API/access documentation, request budget, and disable switch. Respect terms, robots and rate limits; no CAPTCHA/authentication bypass. Honor Retry-After, cache ETags/Last-Modified, time out fetches, cap bytes and pages, prevent private-IP/redirect SSRF, and use deterministic fixture tests. Fetch failures must not mark all jobs removed; lifecycle updates require a successful complete scan. Prefer original ATS provenance. Ashby may need jobUrl-derived identity because its documented public payload has no guaranteed ID.

## Location normalization

Free-text locations such as "Toronto, Ontario", "Vancouver, BC", "Remote - Canada" or "North America Remote" are normalized deterministically into `job_locations` rows with country, region, city, remote flag, applicant countries and a confidence score with recorded evidence. Confidence is assigned by evidence type, highest first: `jobLocation.addressCountry` from JSON-LD or an ATS country field, `applicantLocationRequirements`, a recognised city plus province or state, an explicit "Remote Canada", a continental region such as "North America Remote", and finally a bare "Remote". A bare "Remote" never implies eligibility anywhere. The existing `countryCoverage()` and `matchesCountries()` functions remain the query API; they read structured rows when present and fall back to text matching for rows imported before Phase 5. Preferences express eligibility as selected countries plus the existing worldwide and unknown-country toggles, which cover the "Canada only", "Canada plus US remote" and "worldwide remote" cases. Normalization never calls a model.

## Matching design

1. Evaluate explicit hard constraints first (country/work authorization, work type, employment, seniority, excluded companies/skills). Failed constraints are placed outside the normal ranked list; unknown constraints are visibly unresolved. A posting that omits work arrangement or seniority is evaluated rather than rejected, so the AI judges the missing field from the description.
2. Cheap lexical retrieval and configurable negative signals narrow the candidate set. These are retrieval signals, never presented as semantic AI evaluation.
3. Embed job content and the minimal relevant structured profile; version/cache by content hash and model. Retrieve candidates using cosine similarity and pgvector.
4. Evaluate the top bounded set with structured LLM output for role (20), experience (20), skills (15), leadership (15), industry (10), location (10), compensation (5), career direction (5). Each factor is 0–1 with evidence and uncertainty. Validate schema, reject out-of-range scores, and never let model output override hard constraints.
5. Aggregate weighted factors to a 0–100 overall score; qualification normalizes experience/skills/leadership, interest normalizes role/industry/location/compensation/career direction. A user-configured total must equal 100. Missing salary has neutral fit and reduced confidence; do not infer currency conversions without a dated rate.
6. Return evidence, gaps, transferable skills, progression category, and confidence based on data completeness. Store weights/model/prompt/profile versions for reproducibility. Explicit preferences dominate later learned signals.

LLMs are for structured resume suggestions (user-reviewed), title expansion, semantic reasoning, progression explanation and digest prose. Parsing, access control, normalization, deduplication keys, filters, aggregation, scheduling and alert thresholds remain deterministic. Retrieved content is data separated from instructions; the evaluator has no tools, credentials, or authority to submit applications. Only minimal profile fields leave the server. Phase 1 extracts text locally and leaves profile editing in the user's control.

## Authentication and privacy boundary

Use Node's scrypt with a random salt and OWASP work factors, random 256-bit session tokens, SHA-256 token storage, HTTP-only SameSite=Lax cookies and Secure cookies on HTTPS. Enforce configured application Origin on writes, database-backed login/registration/upload limits and owner-scoped data access. The default Compose stack binds to loopback. This is a local foundation, not a production launch: verified email/recovery, external identity provider or MFA, deployment-level throttling, HTTPS, least-privilege DB credentials, managed encryption/backups, retention/export and a security review are production prerequisites.

Resume uploads: maximum 5 MiB, permitted signatures/extensions, bounded text extraction, original separate from profile, no HTML rendering. Reject scanned PDFs without extractable text with a helpful message. Do not promise OCR or AI extraction in Phase 1. Seed only an explicitly requested fictional profile; never install a shared demo password or fabricate live opportunities.

## MVP cost assumptions

Phase 1 local Compose has no cloud or API charges, excluding the host computer. Budget assumption for a later small single-host deployment: USD 15–40/month for compute/storage/backups; this is an estimate, not a vendor quote. Managed AWS services, redundant databases and NAT gateways can materially exceed it. Phase 3 should have per-run job/token caps and a user-configured monthly budget; calculate AI charges from recorded tokens and selected model prices. No paid search or notification provider is required for Phase 1. See documentation discovery below for verified API pricing when enabling AI.

For Phase 3, a configurable starting point is GPT-5.4 mini for structured explanations and text-embedding-3-small for retrieval, subject to account access and evaluation. Documentation checked during design lists USD 0.75 per million input tokens and 4.50 per million output tokens for [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), and USD 0.02 per million embedding tokens for [text-embedding-3-small](https://developers.openai.com/api/docs/models/text-embedding-3-small). An illustrative monthly workload of 3,000 explanations at 2,000 input/300 output tokens each costs USD 8.55, plus USD 0.06 for 3 million embedding tokens, before retries or other processing. Allocate USD 25/month initially with a hard application budget; verify prices again before enabling billing-dependent work. No model or key is wired into Phase 1.

## Phased implementation and verification

### Phase 0 — documentation discovery

Read actual APIs before implementation: [Next.js cookies](https://nextjs.org/docs/app/api-reference/functions/cookies), [route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route), [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql), [migrations](https://orm.drizzle.team/docs/migrations), [Node crypto](https://nodejs.org/api/crypto.html), [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [pg-boss](https://github.com/timgit/pg-boss), [unpdf text extraction](https://github.com/unjs/unpdf#extract-text-from-pdf), and [Mammoth raw text](https://github.com/mwilliamson/mammoth.js#basic-conversion).

Allowed patterns: await Next cookies and dynamic params; parameterized Drizzle queries and versioned SQL; async scrypt; unpdf `getDocumentProxy`/`extractText`; Mammoth `extractRawText`. Avoid synchronous request-path hashing, rendering document HTML, using sync cookies, or exposing DB credentials to the client.

### Phase 1 — foundation (complete)

Implement the workspace, database migration, real authentication, private profile/preferences forms, TXT/PDF/DOCX upload/download/delete, responsive light/dark dashboard with filters and genuine empty states, job detail and persistent user status. Copy the documented APIs above. Verify lint, strict typecheck, build, deterministic unit tests, real-DB integration tests, and Playwright account/profile/upload/authorization flows. Compose must start without credentials for external services. Do not claim matching/discovery is running.

### Phase 2 — discovery (implemented)

Implemented connectors for the official Greenhouse and Lever APIs, Ashby's public posting API, the Workable, Personio, SmartRecruiters and Rippling board APIs, the RemoteOK, Jobicy, Remotive, The Muse, Himalayas and We Work Remotely feeds, the credentialed USAJOBS and Adzuna search APIs, and allowlisted JSON-LD `JobPosting` pages. The transport is HTTPS-only, fixed-host, redirect-rejecting, DNS-pinned, size/time bounded, and rejects non-public addresses. Provider payloads are Zod-validated and normalized without inventing missing values; HTML becomes bounded text. User-triggered scans upsert canonical jobs, retain provider/external-ID provenance, update changed descriptions, and isolate per-job failures. Complete employer-owned feeds mark disappearances after a complete scan; rolling multi-employer feeds never mark removals. Resumable scheduling remains in Phase 4.

### Phase 3 — matching (current)

Implemented user-triggered and post-sync batch evaluation with `text-embedding-3-small`, cached 1,536-dimensional target/job pgvector embeddings, cosine similarity, hard-filter precedence, GPT-5.4 Mini Structured Outputs, Zod response validation, deterministic weighted aggregation, explicit unevaluated failures, per-evaluation token/cost tracking, and a user-configurable monthly budget. Target embeddings are invalidated when profile/preferences change; job embeddings use content hashes. Preferences select countries for list filtering and evaluation, and the post-sync batch evaluates at most the configured number of eligible new or changed jobs (default 5). Retrieved descriptions remain data, the evaluator has no tools, and invalid or unavailable AI never persists a score. Local verification and repeatable commands are recorded in [Phase 3 validation](phase-3-validation.md). Scheduled re-evaluation remains with Phase 4.

The current budget guard sums the latest persisted match costs in the UTC month; re-evaluation overwrites usage, failures are not accounted for, and concurrent requests do not reserve budget. It is not a strict billing cap. Prices assume the default models. An append-only usage ledger, atomic reservations, model-specific prices, and immutable profile/preferences/prompt snapshots are still needed. Saved scores remain visible after profile/preferences changes until manually re-evaluated; only target embeddings are invalidated automatically. Hard constraints currently cover location, employment, seniority and comparable salary; work authorization and excluded companies/skills are not enforced as hard constraints.

### Phase 4 — automation (current)

Implemented with pg-boss in `apps/worker`: four queues (`scan-source`, `schedule-sources`, `evaluate-batch`, `housekeeping`) with per-source singleton keys, exponential-backoff retries and bounded expirations. `schedule-sources` runs every minute and claims due sources through a guarded `next_run_at` update, so a duplicated or restarted tick cannot enqueue the same slot twice. `housekeeping` runs hourly, removes expired sessions, expired rate-limit buckets and read notifications older than 90 days, and generates the opt-in daily digest. The worker publishes a database heartbeat that the Automation page reads, and a missing or stale heartbeat is shown as "Not running" rather than hidden.

Scheduled scans reuse the interactive scan engine from `packages/automation` and the existing per-workspace `jobfinder:discovery` advisory lock, so a scheduled scan and a user-triggered scan can never overlap. A retried scan reuses the pg-boss job id as its `search_runs.id`, so a crash mid-scan resumes as one run instead of two. Only a complete, removal-safe scan marks listings removed, exactly as in Phase 2. Evaluation runs one bounded batch per changed scan against the existing monthly budget check and monthly cost accounting.

Watchlists, alerts and the digest are deterministic. Watchlist entries are user-scoped with a normalized company key; an entry naming a Greenhouse, Lever or Ashby board owns the employer source the worker scans on its schedule, and removing the entry disables that source instead of deleting its provenance. Alerts are opt-in in-app records written when an evaluated score reaches `notifyMinScore`, deduped by user and evaluation instant. The daily digest is opt-in, runs during the chosen UTC hour (or on demand), and only its narrative sentence is a model call — the counts, ordering and highlight selection are computed deterministically. No email, SMS, push or other outbound message exists in this phase. Local verification is recorded in [Phase 4 validation](phase-4-validation.md).

One deliberate boundary remains: the interactive `POST /api/sources/:id` sync still executes the shared engine inside the Next.js request path, because it is an explicit, bounded, user-triggered action with visible progress. All scheduled network work — scans, evaluation, alerts, digests and cleanup — runs only in the worker. Routing the interactive sync through pg-boss as well is the remaining Phase 4 follow-up; it is listed in the validation document rather than implied.

### Phase 5 — advanced discovery (partially implemented)

Implemented company intake and worker resolution now cover parts of steps 2–5 and bounded HTTP/AI extraction from step 9. Owner-scoped candidates retain the supplied website URL. A `resolve-company` pg-boss queue discovers careers pages and supported ATS APIs, then creates scheduled sources; custom careers sources use JSON-LD followed by evidence-validated AI extraction. `activity_events` persists private progress and generic worker lifecycle events for live polling. The Companies UI accepts name/URL or bulk CSV/domain input. This does not implement the shared pool, isolated browser service, captured API replay or browser navigation described below. See [current validation and limitations](company-discovery-validation.md).

The remaining target design is described in the order below. Each step ships behind its own verification and can stop independently; nothing later depends on the AI step.

1. **Shared job pool.** Move `jobs`, `job_references` and `companies` to shared records with per-user `job_matches`, `saved_jobs` and archiving, as the schema section already intends. Keep manual entries private. Migrate existing per-owner rows by canonical URL and verify no user gains visibility into another user's manual entries.
2. **Company discovery.** Add `company_candidates` fed by uploaded seed lists and, where a permitted search API is configured, `site:example.com careers` style queries. Deduplicate by registrable domain. No candidate becomes a `companies` row without a resolved careers URL.
3. **Career URL finder.** For each candidate, fetch the homepage through a separate discovery transport that follows at most three redirects to public hosts, respects robots.txt, caps bytes and time, and blocks private addresses as the connector transport already does. Score links whose text or path contains careers, jobs, opportunities, join us, join our team, work with us, employment or open positions, then probe `/careers`, `/jobs`, `/careers/jobs`, `/company/careers` and `/about/careers`. Store `careers_url`, `status`, `last_checked_at` and `next_check_at`; do not rediscover a resolved company on every run.
4. **ATS detector.** Inspect the resolved careers page for redirects, anchors, iframes and script sources matching the ATS host list, extract the board key, and create a `job_sources` row for the existing Greenhouse, Lever or Ashby connector. Add Workday, SmartRecruiters, iCIMS and Taleo connectors behind the same `SourceConnector` contract only where the vendor documents public access. Sanitized fixtures per ATS; the detector is pure and unit-tested against saved HTML.
5. **JSON-LD generalization.** Replace the `JSON_LD_ALLOWED_HOSTS` environment allowlist with the per-company `crawl_strategy` gate, crawl the listing page for individual posting links up to a page cap, and read `applicantLocationRequirements`, `jobLocationType`, `baseSalary` and `validThrough`. Robots and terms are checked per company and recorded before the strategy is enabled.
6. **Structured locations.** Add `job_locations`, the deterministic normalizer and confidence table from the location section, backfill existing jobs, and switch list filtering and hard constraints to structured rows with text fallback.
7. **Saved API patterns.** For custom career sites, run Playwright inside an isolated worker container with no database credentials, record XHR/fetch requests that return job JSON, and save a `crawl_patterns` row with the URL template and request body. Later refreshes replay the pattern over plain HTTP; the browser runs again only when the pattern fails validation.
8. **Browser crawler.** Where no pattern exists, use Crawlee with Playwright to open the careers page, select a country filter when present, paginate up to a cap, collect posting links and extract each posting through the JSON-LD, then HTML, extractor. Concurrency, request queue and rate limits come from Crawlee; robots and per-host budgets from the provider registry.
9. **Bounded AI navigation.** Only for sites the crawler cannot map, send page URL, trimmed DOM outline, visible text, links, buttons and forms to the model and ask it to locate the openings list. The model returns a proposed action such as click, select or navigate; a browser controller validates the action against an allowlist of roles, same-host navigation and a step budget before Playwright executes it. Page content is data, never instructions. Each session records its transcript and cost against the monthly budget, and a successful map is saved as a pattern so the model is not consulted again.
10. **Cross-source deduplication.** Extend the canonical identity from URL hash to a normalized company, title and location key with description similarity, so a posting mirrored on an ATS board and a company page becomes one job with two references.

Verify each step with fixture-based unit tests, a real-database integration test, and an opt-in live test per new provider. Publicly reachable does not mean permitted to crawl: every enabled strategy records the policy check that allowed it.

### Phase 6 — application intelligence

Expand status tracking to contacts/interviews/follow-ups and user-reviewed writing assistance. Verify all data is user-scoped and explicit preferences dominate feedback. Applications are never submitted automatically.

### Final verification before production

Reconcile implementation with this plan and current official APIs, exercise failure paths, scan dependencies, build containers, run E2E on a clean database, review secrets/retention and complete the production authentication/privacy prerequisites. CI deployment is intentionally deferred until a target environment is approved and configured.
