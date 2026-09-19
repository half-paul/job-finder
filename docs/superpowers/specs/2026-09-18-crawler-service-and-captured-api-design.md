# Crawler service and captured-API rung

Date: 2026-09-18

This is a delta against
[`2026-09-15-company-import-and-adaptive-scraping-design.md`](./2026-09-15-company-import-and-adaptive-scraping-design.md).
That spec stands, and is cited below as `design.md`; the companion
[implementation plan](../plans/2026-09-15-company-import-and-adaptive-scraping.md)
is cited as `plan.md`. Read the design first: the crawler protocol, the browser policy, the
budgets and the crawl algorithm are specified there and are not restated here.
This document records only what changed in the three days since it was written,
the decisions those changes force, and the scope of the remaining work.

## Why now

`AGENTS.md:17` lists `apps/crawler` as deferred, and `TODOS.md` carries the two
follow-ups (captured-API connector, scan wiring) that were dropped when the
Phase 5 branch landed. Everything on the worker side of the protocol now exists
and is tested; the service that answers it does not. The result is a ladder
whose two cheapest fallback rungs are unreachable, so any company without an ATS
or JSON-LD goes straight to paid AI extraction.

## What already exists

| Piece                                                          | Location                                         | State                         |
| -------------------------------------------------------------- | ------------------------------------------------ | ----------------------------- |
| Crawler HTTP protocol, `CrawlPatternSpec`, JSON pointer helper | `packages/shared/src/crawler.ts`                 | Complete                      |
| `CrawlerClient`, HTTP implementation, `crawlerClientFromEnv`   | `packages/job-sources/src/crawler-client.ts`     | Complete, no caller           |
| `Browser` connector                                            | `packages/job-sources/src/connectors/browser.ts` | Complete, tested, unreachable |
| Pattern inference and validation                               | `packages/discovery/src/patterns.ts`             | Complete, tested, unread      |
| `crawl_patterns` table                                         | `packages/db/src/schema.ts:374`, migration 0006  | Complete, unwritten           |
| `browser` and `captured-api` in the strategy contract          | `packages/shared/src/discovery.ts:23-31`         | Complete                      |

Task 8 of the Phase 5 plan is therefore finished, contrary to what the plan's
checkboxes imply. The remaining work is Task 9, Task 10, the resolver rung and
the service itself.

## What is missing

1. `apps/crawler` — the Playwright HTTP service, per `design.md:168-175`.
2. `packages/job-sources/src/connectors/captured-api.ts`, replacing the throw in
   `createConnector`'s `CapturedApi` branch (`packages/job-sources/src/index.ts:297`).
3. Scan wiring: load the source's `crawl_patterns` row in
   `packages/automation/src/scan.ts`, pass a `crawlerClient`, mark the pattern
   verified after a successful run.
4. Resolver rungs: `packages/discovery/src/resolver.ts` never emits a
   `CapturedApi` or `Browser` resolution, so neither connector is ever selected.
5. Compose service, Dockerfile, `.env.example`, CI.

## Decisions

### Ladder order, and what happens when the crawler is down

`crawlStrategies` already documents the cost order: `none`, `ats`, `json-ld`,
`captured-api`, `browser`, `ai`. The resolver will follow it. When a company
yields no ATS and no JSON-LD, resolution attempts `capture` and validates the
result into a pattern; failing that it creates a `Browser` source; failing that
it settles on the existing AI rung.

When `CRAWLER_URL` is unset or the service is unreachable, resolution records a
warning in the activity feed and settles on the AI rung. It does not fail the
candidate. This is a deliberate departure from "nothing pretends to run when the
worker or crawler is down" (`plan.md:24`): that rule was written when AI
extraction did not exist and there was no rung below the browser. Companies that
resolve through AI today must keep resolving when the crawler container is
absent, so a missing optional service degrades rather than breaks. The warning
is what keeps it honest — the user is told the cheaper rung was skipped and why.

### Crawler browser identity

The crawler sends Chromium's real user agent with ` JobFinder/1.0` appended, and
matches robots groups on the token `JobFinder` via `discoveryAgentToken`.

Two reasons. First, `design.md:127` still names `JobFinderBot/1.0`, which is
stale: that token was changed to `JobFinder/1.0` on 2026-09-18 because Akamai
Bot Manager resets the connection for any user agent matching
`/bot|crawler|spider|curl/i` before sending a response, turning a refusal into a
hang. Second, Chromium's default headless user agent carries a `HeadlessChrome`
token that many edges reject outright. Appending our own product token keeps the
crawler honestly identifiable — a site that wants to exclude us can still do so
by name in robots.txt — without inheriting a string that is blocked on sight.

### Robots content-type guard

`RobotsCache.load` (`packages/discovery/src/transport.ts`) calls
`parseRobots(text)` on any 200 response without checking the content type. A
`robots.txt` that redirects to an HTML page — `www.lululemon.com/robots.txt`
301s to a storefront homepage — parses as an empty ruleset, which means
allow-everything. The crawler enforces robots before navigation and would
inherit the same flaw, so the guard is fixed once here rather than duplicated:
a 200 whose content type is not `text/plain` is treated as an unverifiable
policy and stops the run, the same as any other unavailable check.

### Module boundaries

`apps/crawler` keeps the file split from `plan.md:47`: `index.ts` (HTTP,
bearer auth, Zod validation), `policy.ts` (robots, host allowlist, non-public IP
denial, resource blocking), `session.ts` (browser lifecycle and budgets),
`capture.ts`, `crawl.ts`, `extract.ts`.

`policy.ts` and `extract.ts` are pure — they take URLs, rules and HTML, and
return decisions and postings. Only `session.ts` touches Playwright. This keeps
the browser-dependent surface to one file and lets the extraction rules, which
is where the bugs will be, run under Vitest against fixtures.

The service imports `@jobfinder/shared` and the pure `parseRobots` /
`robotsAllows` from `@jobfinder/discovery`. It never imports `@jobfinder/db` and
receives no database credentials, per `design.md:17` and `design.md:170`.

## Data flow

```
resolve-company job
  → resolveCompanyWebsite
      → ATS detected?        → SupportedAts source          (strategy: ats)
      → JSON-LD present?     → Careers source               (strategy: json-ld)
      → crawlerClient.capture → validatePattern
                                 → crawl_patterns row
                                 + CapturedApi source       (strategy: captured-api)
      → crawler reachable?   → Browser source               (strategy: browser)
      → otherwise            → Careers source               (strategy: ai)

scan-source job
  → CapturedApi → replay pattern over the connector transport, page by page
  → Browser     → crawlerClient.crawl
  → both        → normalize → existing keyword gate → PostgreSQL
```

The resolve handler writes the `job_sources` row today
(`apps/worker/src/handlers.ts:260`). The `CapturedApi` path additionally inserts
the `crawl_patterns` row inside the same transaction, so a source can never
exist without the pattern it needs.

## Non-goals

The crawler renders JavaScript. It does not defeat access controls. Robots is
checked before navigation, a CAPTCHA or login wall ends the session with
`kind: "captcha"` and no retry (`design.md:173`), credentials are never sent, and no attempt is
made to disguise the client beyond the honest user agent above. Sites that deny
access to every client stay denied: `shop.lululemon.com` returns 403 to real
Chrome, and this work does not change that. What it does change is that a
JavaScript-rendered careers page — Avature, a Workday SPA, Pinpoint — becomes
readable, and `corporate.lululemon.com/careers` moves off the paid AI rung.

## Testing

- `policy.ts` and `extract.ts`: Vitest against fixture HTML under
  `tests/fixtures/discovery/`, no browser.
- Captured-API connector and scan wiring: the existing fake-`CrawlerClient`
  pattern, as `connectors/browser.ts` is already tested.
- Resolver ladder: injected fake crawler client covering capture success,
  capture failure into browser, and client absent into AI.
- Service end to end: `tests/e2e/crawler.spec.ts` against a local fixture site,
  covering a JSON-LD listing, a link-following listing, pagination, the page and
  job caps, and a CAPTCHA marker ending the session.
- Robots guard: a `robots.txt` returning HTML with a 200 must stop the run.

## Open risk

Resolution now costs a browser session per company without an ATS or JSON-LD,
where it previously cost an AI call. The 60-second session budget and the
one-session-per-host rule from `design.md:174` bound it, but a 500-row import
arriving at once is a different shape of load than the current ladder produces.
Queue behaviour under that load is not designed here and should be measured
before a large import is attempted.
