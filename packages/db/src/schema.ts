import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  primaryKey,
  index,
  uniqueIndex,
  check,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  Profile,
  Preferences,
  JobMatch,
  PolicyCheck,
  PatternFieldMap,
} from "@jobfinder/shared";
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text().notNull().default("user"),
  createdAt: createdAt(),
});
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);
export const rateLimits = pgTable("rate_limits", {
  key: text().primaryKey(),
  count: integer().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const profiles = pgTable("user_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  data: jsonb().$type<Profile>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const preferences = pgTable("career_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  data: jsonb().$type<Preferences>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const resumes = pgTable(
  "resumes",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text().notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer().notNull(),
    originalBase64: text("original_base64").notNull(),
    extractedText: text("extracted_text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("resumes_owner_idx").on(t.userId)],
);
export const companies = pgTable("companies", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  domain: text(),
  industry: text(),
  size: text(),
  overview: text(),
});
export const jobSources = pgTable(
  "job_sources",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    identity: text(),
    company: text().notNull(),
    region: text().notNull().default("global"),
    etag: text(),
    lastModified: text("last_modified"),
    provider: text().notNull(),
    board: text().notNull(),
    enabled: boolean().default(true).notNull(),
    sourceUrl: text("source_url"),
    /** Manual sources never run on a schedule; the worker owns scheduled runs. */
    schedule: text().notNull().default("Manual"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("source_owner_identity_unique").on(t.ownerId, t.identity),
    index("sources_due_idx").on(t.enabled, t.nextRunAt),
  ],
);
export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    companyId: uuid("company_id").references(() => companies.id),
    title: text().notNull(),
    company: text().notNull(),
    description: text().notNull(),
    location: text().notNull(),
    country: text().notNull(),
    industry: text().notNull(),
    employmentType: text("employment_type").notNull(),
    seniority: text().notNull(),
    workType: text("work_type").notNull(),
    salaryPeriod: text("salary_period").notNull().default("year"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    currency: text().notNull(),
    jobUrl: text("job_url").notNull(),
    canonicalHash: text("canonical_hash").notNull(),
    descriptionHash: text("description_hash").notNull(),
    source: text().notNull().default("Manual"),
    lifecycle: text().notNull().default("Active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("jobs_owner_canonical_unique").on(t.ownerId, t.canonicalHash),
    index("jobs_discovered_idx").on(t.discoveredAt),
    check(
      "salary_range",
      sql`${t.salaryMin} IS NULL OR ${t.salaryMax} IS NULL OR ${t.salaryMin} <= ${t.salaryMax}`,
    ),
  ],
);
export const jobReferences = pgTable(
  "job_references",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id),
    active: boolean().notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    externalId: text("external_id").notNull(),
    url: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.externalId] })],
);
export const jobMatches = pgTable(
  "job_matches",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    data: jsonb().$type<JobMatch>().notNull(),
    version: text().notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    embeddingTokens: integer("embedding_tokens").notNull().default(0),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.jobId] })],
);
export const targetEmbeddings = pgTable(
  "target_embeddings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    model: text().notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.model] })],
);
export const jobEmbeddings = pgTable(
  "job_embeddings",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    model: text().notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.model] })],
);
export const savedJobs = pgTable(
  "saved_jobs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    status: text().notNull(),
    notes: text().notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.jobId] })],
);
export const jobStatusHistory = pgTable("job_status_history", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  status: text().notNull(),
  createdAt: createdAt(),
});
export const auditEvents = pgTable("audit_events", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  action: text().notNull(),
  createdAt: createdAt(),
});

export const searchRuns = pgTable(
  "search_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text().notNull().default("Running"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    discovered: integer().notNull().default(0),
    added: integer().notNull().default(0),
    updated: integer().notNull().default(0),
    removed: integer().notNull().default(0),
    filtered: integer().notNull().default(0),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    error: text(),
    /** Manual for a user-triggered sync, Schedule for a worker run. */
    trigger: text().notNull().default("Manual"),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("search_runs_owner_started_idx").on(t.userId, t.startedAt)],
);

export const companyWatchlists = pgTable(
  "company_watchlists",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    company: text().notNull(),
    /** Case- and whitespace-normalized key; one entry per company per user. */
    companyKey: text("company_key").notNull(),
    domain: text().notNull().default(""),
    provider: text(),
    board: text().notNull().default(""),
    priority: text().notNull().default("Interesting"),
    notes: text().notNull().default(""),
    /** Set when a watchlist entry owns a directly-scanned employer source. */
    sourceId: uuid("source_id").references(() => jobSources.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("watchlist_owner_company_unique").on(t.userId, t.companyKey),
    index("watchlist_owner_idx").on(t.userId),
  ],
);

/**
 * A company the user asked us to import. The worker resolves each candidate
 * once into a strategy and a `job_sources` row; it is not re-resolved until
 * its source fails repeatedly or the user presses Retry.
 */
export const companyCandidates = pgTable(
  "company_candidates",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    watchlistId: uuid("watchlist_id").references(() => companyWatchlists.id, {
      onDelete: "set null",
    }),
    name: text().notNull(),
    /** Registrable domain, lowercase. One candidate per domain per user. */
    domain: text().notNull(),
    origin: text().notNull().default("seed"),
    websiteUrl: text("website_url"),
    status: text().notNull().default("Pending"),
    careersUrl: text("careers_url"),
    ats: text(),
    atsKey: text("ats_key"),
    strategy: text().notNull().default("none"),
    sourceId: uuid("source_id").references(() => jobSources.id, {
      onDelete: "set null",
    }),
    policyCheck: jsonb("policy_check").$type<PolicyCheck>(),
    error: text().notNull().default(""),
    attempts: integer().notNull().default(0),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("candidate_owner_domain_unique").on(t.userId, t.domain),
    index("candidate_status_next_idx").on(t.status, t.nextCheckAt),
  ],
);

/** A JSON request the crawler saw a careers page make; refreshes replay it. */
export const crawlPatterns = pgTable(
  "crawl_patterns",
  {
    id: uuid().primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id, { onDelete: "cascade" }),
    kind: text().notNull().default("http-json"),
    urlTemplate: text("url_template").notNull(),
    method: text().notNull().default("GET"),
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    body: text(),
    jobsPath: text("jobs_path").notNull(),
    fieldMap: jsonb("field_map").$type<PatternFieldMap>().notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    failures: integer().notNull().default(0),
  },
  (t) => [uniqueIndex("crawl_pattern_source_unique").on(t.sourceId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    title: text().notNull(),
    body: text().notNull().default(""),
    score: integer(),
    /** Deterministic identity so a repeated worker pass never duplicates an alert. */
    dedupeKey: text("dedupe_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notifications_owner_dedupe_unique").on(t.userId, t.dedupeKey),
    index("notifications_owner_created_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * Small key/value store for worker bookkeeping: the heartbeat the diagnostics
 * view reads, and the last completed automatic scan and digest instants.
 */
export const automationState = pgTable("automation_state", {
  key: text().primaryKey(),
  value: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** Durable, owner-scoped progress. Never store credentials or page contents. */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id").references(() => companyCandidates.id, {
      onDelete: "cascade",
    }),
    sourceId: uuid("source_id").references(() => jobSources.id, {
      onDelete: "cascade",
    }),
    runId: uuid("run_id"),
    actor: text().notNull(),
    stage: text().notNull(),
    level: text().notNull().default("info"),
    message: text().notNull(),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("activity_owner_created_idx").on(t.userId, t.createdAt)],
);
