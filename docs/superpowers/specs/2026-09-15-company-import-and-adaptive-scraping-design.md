# Company import and adaptive scraping (Phase 5, part 1)

Date: 2026-09-15
Status: approved design, awaiting implementation plan

## Goal

Let a user provide an initial list of companies. For each company the worker finds the careers page, works out the cheapest permitted way to read its openings, and imports positions through the existing scan engine so the keyword rules from the Preferences page gate what is stored. When a company exposes no supported API or structured data, a Playwright-based crawler service reads the page instead.

This implements Phase 5 steps 2, 3, 4, 5 (per-company gate only), 7 and 8 from `doc/architecture.md`. It does not implement step 1 (shared job pool), step 6 (structured locations), step 9 (AI navigation) or step 10 (cross-source deduplication).

## Decisions taken

- Input: paste box and CSV upload on the Watchlist page. No separate Companies page.
- Retrieval ladder this round: ATS detection, then Schema.org JSON-LD on the careers page, then a captured JSON API replayed over plain HTTP, then a Playwright DOM crawl. No model calls.
- Keywords: the existing `keywordFilter` import gate applies unchanged to every new source. Keywords are not typed into site search forms.
- Isolation: Playwright runs in a separate `apps/crawler` container with no database credentials. The worker talks to it over HTTP on the Compose network.
- Every new retrieval strategy is a `SourceConnector`, so scan runs, removal safety, schedules, evaluation and alerts are reused without change.
- Sources and candidates stay owner-scoped like watchlist sources today.

## Architecture

```
Watchlist page ──POST /api/companies/import──▶ company_candidates (Pending)
                                                      │  pg-boss resolve-company
                                                      ▼
                                   packages/discovery: resolver
                   ┌────────────────┬─────────────────┬──────────────────┐
                   ▼                ▼                 ▼                  ▼
            ATS detector      JSON-LD probe    API capture (crawler)  Browser crawl
                   │                │                 │                  │
                   ▼                ▼                 ▼                  ▼
      job_sources Greenhouse   job_sources     crawl_patterns +     job_sources
      / Lever / Ashby          provider=Careers job_sources          provider=Browser
                                               provider=CapturedApi
                   └────────────────┴─────────────────┴──────────────────┘
                                                      ▼
                            existing scan engine (packages/automation/scan.ts)
                            keywordFilter gate → jobs / job_references → evaluation
```

### Packages and apps

- `packages/discovery` (`@jobfinder/discovery`, new): discovery transport, robots parser, careers URL finder, ATS detector, seed list parser, pattern validator, resolver. Depends on `@jobfinder/job-sources` and `@jobfinder/shared`; never imported by `job-sources`. No Next.js imports.
- `packages/job-sources`: three new connectors, `Careers`, `CapturedApi`, `Browser`, plus a typed `CrawlerClient` interface the `Browser` connector and the resolver call. The HTTP implementation of that client lives here too; tests inject a fake.
- `apps/crawler` (`@jobfinder/crawler`, new): Node HTTP server plus Playwright Chromium. Two endpoints, shared-secret header, no database access.
- `apps/worker`: new queue `resolve-company`; handler calls the resolver.
- `apps/web`: import panel and candidate table on the Watchlist page; new routes under `/api/companies`.

## Data model

New tables, both in `packages/db/src/schema.ts` with generated SQL committed.

### company_candidates

| column | type | notes |
| --- | --- | --- |
| id | uuid pk | |
| user_id | uuid fk users cascade | |
| watchlist_id | uuid fk company_watchlists set null | entry created at import |
| name | text | as given, or domain when absent |
| domain | text | registrable domain, lowercase |
| origin | text | `seed` only this round |
| status | text | `Pending`, `Resolving`, `Resolved`, `NoCareersPage`, `Unsupported`, `Blocked`, `Failed` |
| careers_url | text null | resolved page |
| ats | text null | `Greenhouse`, `Lever`, `Ashby`, `Workday`, `SmartRecruiters`, `iCIMS`, `Taleo` |
| ats_key | text null | board or tenant key |
| strategy | text | `none`, `ats`, `json-ld`, `captured-api`, `browser` |
| source_id | uuid fk job_sources set null | the source this candidate produced |
| policy_check | jsonb | `{ robotsAllowed, robotsUrl, checkedAt, userAgent }` |
| error | text | last failure, plain language |
| attempts | integer | resolve attempts |
| last_checked_at, next_check_at | timestamptz | |
| created_at, updated_at | timestamptz | |

Unique on (`user_id`, `domain`). Index on (`status`, `next_check_at`).

### crawl_patterns

| column | type | notes |
| --- | --- | --- |
| id | uuid pk | |
| source_id | uuid fk job_sources cascade | one active pattern per source |
| kind | text | `http-json` only this round |
| url_template | text | absolute HTTPS URL; may contain `{page}` |
| method | text | `GET` or `POST` |
| headers | jsonb | allowlisted request headers only (`accept`, `content-type`, `x-requested-with`) |
| body | jsonb null | POST body, may contain `{page}` |
| jobs_path | text | JSON pointer to the array of postings |
| field_map | jsonb | `{ title, url, id, location, description, postedAt }` each a JSON pointer relative to a posting |
| discovered_at, last_verified_at | timestamptz | |
| failures | integer | consecutive replay failures |

### job_sources

`provider` gains `Careers`, `CapturedApi`, `Browser`. `source_url` holds the careers URL for all three. `board` holds the registrable domain so `sourceIdentity()` stays unique per company. No schema change beyond the new provider values, which are text.

## Input

### Parser (`packages/discovery/src/seed-list.ts`, pure)

Accepts pasted text or CSV text. Each line yields `{ name, domain }`:

- `Acme, acme.com`, `acme.com`, `https://www.acme.com/about` and CSV rows with a `name,domain` or `company,website` header are accepted.
- Domain is lowercased, `www.` stripped, reduced to the registrable domain with a small built-in list of two-level public suffixes (`co.uk`, `com.au`, `co.jp`, `com.br`, and similar). No external suffix library.
- Lines without a parseable domain are reported as rejects with the line number. Nothing is guessed from a bare company name.
- Limits: 500 rows per import, 200 characters per field.

### Endpoint

`POST /api/companies/import` with JSON `{ text }` or `multipart/form-data` with a `file` field. For each parsed row, in one transaction per row:

1. Skip when a candidate with the same domain exists for this user; report it as `duplicate`.
2. Create a watchlist entry (priority `Interesting`, domain set, no provider) unless one exists for the company key; link it.
3. Insert the candidate as `Pending` and enqueue `resolve-company` with singleton key `resolve:{userId}:{candidateId}`.

Response: `{ imported, duplicates, rejected: [{ line, reason }] }`.

`GET /api/companies` lists the user's candidates with joined source and last run. `POST /api/companies/:id/retry` resets a `Failed`, `NoCareersPage` or `Blocked` candidate to `Pending` and re-enqueues. `DELETE /api/companies/:id` removes the candidate and disables its source, mirroring watchlist deletion.

## Resolver (`packages/discovery/src/resolve.ts`)

Runs in the worker for one candidate. Sets `Resolving`, then walks the ladder. Any rung that produces a source finishes the run: `status = Resolved`, `strategy` set, `source_id` set, `next_check_at = now + 30 days`. Every fetch goes through the discovery transport.

### Discovery transport (`transport.ts`)

Same guarantees as `job-sources/transport.ts`: HTTPS only, DNS resolved once and pinned, non-public addresses rejected, 15 s timeout, 4 MB cap, `JobFinderBot/1.0` user agent. Differences: follows up to three redirects, each re-validated against the same rules, and returns the final URL and chain. Before any request to a host it fetches `/robots.txt` once, caches it for the run, and refuses paths disallowed for `JobFinderBot` or `*`. A refusal ends the run as `Blocked` with the matched rule in `error` and `policy_check`.

### Careers URL finder (`careers.ts`, pure scoring plus transport)

1. Fetch `https://{domain}/`. On failure try `https://www.{domain}/`.
2. Extract anchors. Score text and path for `careers`, `jobs`, `join us`, `join our team`, `work with us`, `employment`, `open positions`, `opportunities`, `we're hiring`. Same registrable domain or a known ATS host only.
3. Fetch the best-scoring link. If none scores, probe `/careers`, `/jobs`, `/careers/jobs`, `/company/careers`, `/about/careers` in order, stopping at the first 200.
4. Nothing found: `NoCareersPage`.

### ATS detector (`ats.ts`, pure)

Input: final URL, redirect chain, HTML. Recognises `boards.greenhouse.io`, `job-boards.greenhouse.io`, `boards-api.greenhouse.io`, `jobs.lever.co`, `api.lever.co`, `jobs.ashbyhq.com`, `api.ashbyhq.com`, `*.myworkdayjobs.com`, `jobs.smartrecruiters.com`, `*.icims.com`, `*.taleo.net` in the redirect chain, anchors, iframes, script `src` and embed URLs. Extracts the board key from the path (`/acme`, `/embed/job_board?for=acme`, `/acme/jobs`). Returns `{ ats, key } | null`.

Greenhouse, Lever and Ashby create a `job_sources` row for the existing connector with `schedule = Every 4 hours`, and the watchlist entry gets `provider` and `board` filled so the Watchlist UI shows it exactly like a hand-entered board. Workday, SmartRecruiters, iCIMS and Taleo set `ats` and finish as `Unsupported` with an explanatory error; no source is created and the UI says the vendor is recognised but not yet supported.

### JSON-LD probe

Reuse `extractJobs` from the JSON-LD connector on the careers page HTML. One or more `JobPosting` nodes: create `provider = Careers` source. The `Careers` connector also follows same-host anchors from the listing page to individual posting pages (cap 200 links, 100 pages per scan) and reads JSON-LD there, so listing pages that only link to postings still work. Robots is checked per host at scan time as well.

### API capture

`crawlerClient.capture({ url })`. The crawler loads the page, waits for network idle up to 20 s, and returns every same-host or ATS-host XHR/fetch response that is JSON and contains an array of two or more objects where each has a string field whose name matches `/title|name|position/i` and a field whose value is an absolute or relative URL. It returns `{ url, method, headers, body, jobsPath, sample }` per hit, headers already reduced to the allowlist.

The worker validates each hit with `patterns.ts`: replay through the connector transport, parse, require at least one posting whose title and URL map cleanly, and infer `field_map` from the sample keys (`title|name|position`, `url|absolute_url|applyUrl|link|href`, `id|jobId|requisitionId`, `location|locationName|city`, `description|content|body`, `postedAt|datePosted|createdAt|updatedAt`). The first valid hit becomes a `crawl_patterns` row and a `provider = CapturedApi` source. Pagination: if the URL or body contains a numeric `page`, `offset` or `start` field, the connector rewrites it as `{page}` and walks pages until an empty array or the cap.

### Browser crawl

No pattern: create `provider = Browser` source with `source_url` set to the careers URL. Scans call `crawlerClient.crawl`.

### Re-resolution

Resolved candidates are not re-resolved on a schedule. The scan handler increments a per-source failure counter (existing `search_runs` status `Failed`); three consecutive failures set the candidate back to `Pending` with the previous strategy noted, so a cheaper rung can replace a costlier one or a moved careers page is found again. A candidate is also re-resolved when the user presses Retry.

## Connectors (`packages/job-sources/src/connectors`)

All three return `canMarkRemovals: true` only for a complete walk, `complete: false` when a cap is hit, and populate `externalId` from the posting id when present, otherwise the canonical posting URL.

- `careers.ts`: `search` fetches the careers URL, extracts JSON-LD postings and same-host posting links; `fetchJob` fetches a posting page when the listing had only a link; `normalize` reuses the JSON-LD normalizer and additionally reads `applicantLocationRequirements`, `jobLocationType`, `baseSalary` and `validThrough` into the existing fields (`workType`, `salaryMin/Max`, `currency`, `salaryPeriod`).
- `captured-api.ts`: `search` replays the pattern page by page through `fetchJson`; `normalize` maps by `field_map` and validates with Zod. A replay that returns no parseable posting throws, which the scan records as `Failed` and increments `crawl_patterns.failures`.
- `browser.ts`: `search` calls `crawlerClient.crawl({ url, maxPages: 20, maxJobs: 500 })` and returns the jobs with `complete` from the crawler; `fetchJob` returns the already-fetched record; `normalize` validates with Zod. When `CRAWLER_URL` is unset the connector throws "Browser crawling is not configured; start the crawler service" so the run fails visibly.

## Crawler service (`apps/crawler`)

- Image: `mcr.microsoft.com/playwright:v1.63.0-noble`, runs as non-root. Compose service `crawler` with no `DATABASE_URL`, no published port, `CRAWLER_SECRET` shared with the worker. Worker env `CRAWLER_URL=http://crawler:4000`.
- Auth: `Authorization: Bearer {CRAWLER_SECRET}` required on every request.
- `POST /capture { url }` and `POST /crawl { url, maxPages, maxJobs }`. Request bodies validated with Zod. Both return JSON; errors return `{ error, kind }` where `kind` is `blocked`, `timeout`, `navigation`, `captcha`, or `internal`.
- Browser policy enforced through Playwright request interception: HTTPS only, the target registrable domain plus recognised ATS hosts, deny non-public IPs after DNS lookup, block downloads, media and fonts, deny credentials, deny any navigation off-host. Robots checked before navigation. A page presenting a CAPTCHA or login form (detected by common markers) ends the session with `kind = captcha` and no retry.
- Budgets: one session per host at a time, 60 s per session, 2 s minimum between page loads, 20 pages, 500 postings.
- Crawl algorithm: open careers URL, collect JSON-LD postings, else collect links whose text or path looks like a posting (contains a slug plus `job`, `position`, `opening`, `role`, `career`, or a numeric id) on the same host, follow pagination controls (`rel=next`, text `Next`, `Load more`, `Show more`) up to the cap, then open each posting (cap applies) and extract JSON-LD first, otherwise `h1` as title and the main content text as description, with location from elements whose class or label mentions location. Returns `{ jobs, complete, warnings }` where each job carries `title, url, id?, location?, description, postedAt?`.
- No cookies persist between sessions. No screenshots stored. Logs contain hostnames and counts, never page content.

## Keywords and import

Unchanged. `scan.ts` applies `keywordFilter(normalized, settings)` to every posting before `upsertDiscoveredJob`. Filtered counts and warnings appear in the run exactly as for ATS sources. Manual entries remain ungated.

## Worker

- Queue `resolve-company`, payload `{ userId, candidateId }`, singleton key per candidate, retry limit 2 with backoff, 120 s expiry. Handler: `resolveCandidate(db, crawlerClient, payload, { signal, fetchImpl? })`.
- Scheduler tick also enqueues `Pending` candidates whose `next_check_at` is null or past, so an import survives a worker restart.
- Existing `scan-source` handler unchanged; new connectors are reached through `createConnector`, which now takes an optional `crawlerClient` in `ConnectorOptions`.

## UI (Watchlist page)

- "Import companies" panel: textarea, file input (`.csv`, `.txt`), Import button, result line ("12 imported, 2 duplicates, 1 rejected: line 7 has no domain").
- "Imported companies" table: name, domain, status badge, strategy, careers URL link, last error, Retry and Remove buttons. Statuses use plain wording: "Looking for careers page", "Scanning Greenhouse board", "Reading careers page", "Replaying saved API", "Browser crawl", "No careers page found", "Robots.txt disallows crawling", "Vendor recognised, not yet supported", "Failed".
- Empty state text when no candidate exists. Nothing pretends to run when the worker or crawler is down: the Automation page already reports worker status; the candidate table shows "Waiting for worker" when a candidate has been `Pending` for more than five minutes.

## Errors and safety

- Every refusal is recorded, never silent: robots, private address, redirect off-host, CAPTCHA, size, time.
- A failed or partial scan never marks listings removed.
- Crawler unavailable: resolver stops before the capture rung and sets the candidate `Failed` with "Crawler service unavailable"; ATS and JSON-LD rungs still complete without it.
- The crawler holds no credentials and cannot reach the database; the worker only accepts the crawler's response after Zod validation and applies its own size caps.
- Per-host politeness lives in one place (`packages/discovery/src/budget.ts`) and is shared by the discovery transport and the crawler's request policy.

## Testing

Unit (`tests/unit`, offline, fixtures under `tests/fixtures/discovery`):
- seed list parser: paste formats, CSV headers, suffix reduction, rejects, limits.
- robots parser: allow, disallow, agent precedence, missing file.
- careers link scorer and probe order.
- ATS detector against saved HTML per vendor, including embed iframes and redirect chains.
- pattern inference and validation against saved JSON responses, including pagination rewrite.
- each new connector with injected `fetchImpl` and a fake `CrawlerClient`.
- resolver ladder ordering with injected transport results: ATS wins over JSON-LD, JSON-LD over capture, capture over browser, robots block short-circuits.

Real database (`tests/e2e`):
- import endpoint: dedupe, watchlist linkage, authorization scoping between two synthetic users.
- resolver handler with injected fetch and fake crawler producing each terminal status.
- scan of a `CapturedApi` and a `Browser` source with fakes, asserting keyword gate counts and removal behaviour.

Crawler (`apps/crawler/tests`): Playwright test that serves a static fixture careers site from a local HTTP server and asserts capture and crawl output, request policy denials and the page cap.

Live, opt-in `DISCOVERY_LIVE_SMOKE=1`: resolve one known Greenhouse company and one known JSON-LD careers page; asserts strategy and structure only.

## Documentation

- `doc/architecture.md`: mark Phase 5 steps 2, 3, 4, 5, 7, 8 implemented with the deviations above (per-user candidates, no shared pool, unsupported ATS vendors recorded not connected).
- `AGENTS.md`: add `packages/discovery`, `apps/crawler`, new env keys `CRAWLER_URL`, `CRAWLER_SECRET`, new queue, new test locations.
- `README.md`: crawler service, Compose changes, how to import companies, what happens when the crawler is absent.
- `doc/phase-5-validation.md`: commands run and results.
- `.env.example`: new keys with comments.

## Out of scope

AI-directed navigation, Workday/SmartRecruiters/iCIMS/Taleo connectors, shared job pool, structured locations, cross-source deduplication, typing keywords into site search, search-API driven company discovery.
