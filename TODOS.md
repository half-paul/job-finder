# TODOS

## Company discovery

### Re-resolve a company after repeated scan failures

**What:** Add the `recordSourceFailure` behavior from the plan: reset a candidate to `Pending` after 3 consecutive `Failed` runs and increment `crawl_patterns.failures`.

**Why:** A company whose careers page moves or whose ATS changes stays broken forever today. Nothing resets it, so the user has to notice and press Retry by hand.

**Context:** Deferred from Task 12 of the Phase 5 plan. Nothing in `companies.ts`, `handlers.ts` or `scan.ts` tracks consecutive failures. The retry path (`retryCompany`) already moves a candidate back to `Pending`, so this is the same transition on an automatic trigger.

**Effort:** S
**Priority:** P1
**Depends on:** None

### Two candidates can collide on one job source

**What:** Scope `job_sources` identity so two company candidates resolving to the same ATS board do not overwrite each other's row, or surface a conflict instead.

**Why:** Today the second resolution's `onConflictDoUpdate` silently repoints and relabels the row the first candidate already owns. The first candidate's scans then report the second company's name, and its watchlist entry keeps a stale board.

**Context:** Found by the red-team review of the Phase 5 branch. `apps/worker/src/handlers.ts:268` upserts on `(ownerId, identity)` where identity comes only from the ATS provider and board slug (`packages/discovery/src/ats.ts`). Common triggers: a rebrand, a regional domain, or the same employer imported twice under slightly different names.

**Effort:** M
**Priority:** P2
**Depends on:** None

### One user's bulk import starves every other user

**What:** Make `pendingCompanies` fair across users — round-robin, or cap how many of one user's candidates are claimed per tick.

**Why:** A single 500-row import fills the queue with candidates whose `createdAt` predates everyone else's future imports, and the `resolve-company` queue runs one resolution at a time for the whole deployment.

**Context:** Found by the red-team review. `packages/automation/src/companies.ts` selects the globally oldest 20 pending candidates with no per-user scoping, and `apps/worker/src/index.ts` registers the queue with `batchSize: 1` and `localConcurrency: 1`.

**Effort:** M
**Priority:** P2
**Depends on:** None

### AI budget can be exceeded by concurrent discovery and evaluation

**What:** Use one shared advisory-lock key (or one shared reservation) for both AI spend paths.

**Why:** Discovery extraction locks `hashtext('jobfinder:discovery-budget')` while evaluation locks `hashtext('jobfinder:evaluation')`. Both read the same combined monthly spend, so a resolve-company job and an evaluation batch for the same user can each pass the check and each commit its charge, pushing actual spend past the configured budget.

**Context:** Found by the red-team review. See `packages/automation/src/discovery-ai.ts:30` and `packages/automation/src/evaluation.ts:149`. The duplicated budget-sum query in those two files should be extracted to one helper at the same time.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Activity pagination can skip rows

**What:** Give `GET /api/activity` an explicit pagination envelope and a compound `(createdAt, id)` cursor.

**Why:** The `before` cursor filters on `createdAt` alone, but `created_at` defaults to `now()` and every row written in one transaction shares a timestamp. Paging past a batch boundary can silently skip rows, and the client infers "more exist" from `length === 100`.

**Context:** Found by the api-contract review. See `packages/automation/src/activity.ts` (`listActivity`) and the `activity` branch in `apps/web/app/api/[...path]/route.ts`. Untested today — the audit listed the `before` param as a coverage gap.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Testing

### Close the Phase 5 coverage gaps

**What:** Add tests for the activity `before` cursor, the 90-day `activity_events` purge in `cleanup.ts`, the worker claim-miss and source-supersession paths, and the new rate limits.

**Why:** The Phase 5 coverage audit put the branch at 68% against an 80% target, with 26 gaps. These four are real logic rather than UI interactions, so they are the ones worth automating.

**Context:** The full gap list is in the ship PR's Test Coverage section and in `~/.gstack/projects/half-paul-job-finder/paul-feature-phase-5-company-import-ship-test-plan-20260917-201411.md`. The watchlist Scan buttons are deliberately excluded: clicking them triggers a live network scan, which `AGENTS.md` forbids in a default test run.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Completed

<!-- Finished items move here with a completion annotation. -->
