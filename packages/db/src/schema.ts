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
import type { Profile, Preferences, JobMatch } from "@jobfinder/shared";
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
  },
  (t) => [
    uniqueIndex("source_owner_identity_unique").on(t.ownerId, t.identity),
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
  },
  (t) => [index("search_runs_owner_started_idx").on(t.userId, t.startedAt)],
);
