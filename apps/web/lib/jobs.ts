import "server-only";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  getDb,
  jobs,
  jobMatches,
  savedJobs,
  jobStatusHistory,
  preferences,
} from "@jobfinder/db";
import {
  actionSchema,
  archiveSchema,
  jobInputSchema,
  preferencesSchema,
  defaultPreferences,
  matchesCountries,
} from "@jobfinder/shared";
import { canonicalUrl, digest } from "./security";
import { HttpError } from "./http";
export const visibleJob = (userId: string) =>
  or(isNull(jobs.ownerId), eq(jobs.ownerId, userId));

/**
 * Archived listings are excluded from every list, count and evaluation. They
 * stay in the database so a later sync re-uses the canonical row instead of
 * importing the same posting again.
 */
export const archivedJob = () => isNotNull(jobs.archivedAt);
export const activeJob = () => isNull(jobs.archivedAt);

async function countryCondition(userId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId));
  const settings = preferencesSchema.parse(row?.data ?? defaultPreferences);
  if (!settings.countries.length) return undefined;
  // Resolve country names, codes and feed location labels before pagination.
  // Fetch only location metadata, never every listing's full description.
  const locations = await db
    .select({ id: jobs.id, country: jobs.country, location: jobs.location })
    .from(jobs)
    .where(visibleJob(userId));
  const allowed = locations
    .filter((job) => matchesCountries(job, settings))
    .map((job) => job.id);
  return allowed.length ? inArray(jobs.id, allowed) : sql`false`;
}
export async function listJobs(userId: string, params: URLSearchParams) {
  const page = Math.max(1, Math.min(10000, Number(params.get("page")) || 1));
  const query = (params.get("q") ?? "")
    .slice(0, 200)
    .replace(/[\\%_]/g, "\\$&");
  const conditions = [
    visibleJob(userId),
    params.get("view") === "archived" ? archivedJob() : activeJob(),
    await countryCondition(userId),
  ];
  if (query)
    conditions.push(
      or(
        ilike(jobs.title, `%${query}%`),
        ilike(jobs.company, `%${query}%`),
        ilike(jobs.location, `%${query}%`),
      ),
    );
  if (params.get("work"))
    conditions.push(eq(jobs.workType, params.get("work")!));
  if (params.get("view") === "saved")
    conditions.push(eq(savedJobs.status, "Saved"));
  if (params.get("view") === "applications")
    conditions.push(
      sql`${savedJobs.status} IN ('Preparing Application','Applied','Interviewing','Offer','Rejected','Withdrawn')`,
    );
  const score = Number(params.get("score")) || 0;
  if (score > 0)
    conditions.push(
      sql`(${jobMatches.data}->>'overallScore')::numeric >= ${score}`,
    );
  const db = getDb();
  const rows = await db
    .select({ job: jobs, match: jobMatches.data, state: savedJobs.status })
    .from(jobs)
    .leftJoin(
      jobMatches,
      and(eq(jobMatches.jobId, jobs.id), eq(jobMatches.userId, userId)),
    )
    .leftJoin(
      savedJobs,
      and(eq(savedJobs.jobId, jobs.id), eq(savedJobs.userId, userId)),
    )
    .where(and(...conditions))
    .orderBy(
      params.get("sort") === "newest"
        ? desc(jobs.discoveredAt)
        : sql`(${jobMatches.data}->>'overallScore')::numeric DESC NULLS LAST`,
      desc(jobs.discoveredAt),
    )
    .limit(51)
    .offset((page - 1) * 50);
  return { items: rows.slice(0, 50), hasMore: rows.length > 50, page };
}
export async function getJob(userId: string, id: string) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), visibleJob(userId)));
  if (!job) throw new HttpError(404, "Opportunity not found.");
  const [match] = await db
    .select()
    .from(jobMatches)
    .where(and(eq(jobMatches.jobId, id), eq(jobMatches.userId, userId)));
  const [state] = await db
    .select()
    .from(savedJobs)
    .where(and(eq(savedJobs.jobId, id), eq(savedJobs.userId, userId)));
  const history = await db
    .select()
    .from(jobStatusHistory)
    .where(
      and(eq(jobStatusHistory.jobId, id), eq(jobStatusHistory.userId, userId)),
    )
    .orderBy(desc(jobStatusHistory.createdAt))
    .limit(50);
  return { job, match: match?.data ?? null, state: state ?? null, history };
}
export async function createJob(userId: string, body: unknown) {
  const input = jobInputSchema.parse(body);
  const jobUrl = canonicalUrl(input.jobUrl);
  const [job] = await getDb()
    .insert(jobs)
    .values({
      ...input,
      ownerId: userId,
      jobUrl,
      canonicalHash: digest(jobUrl),
      descriptionHash: digest(input.description),
      postedAt: input.postedAt ? new Date(input.postedAt) : null,
    })
    .onConflictDoNothing()
    .returning();
  if (!job)
    throw new HttpError(409, "This opportunity has already been added.");
  return job;
}
export async function updateStatus(userId: string, id: string, body: unknown) {
  const input = actionSchema.parse(body);
  await getJob(userId, id);
  await getDb().transaction(async (tx) => {
    await tx
      .insert(savedJobs)
      .values({ userId, jobId: id, ...input })
      .onConflictDoUpdate({
        target: [savedJobs.userId, savedJobs.jobId],
        set: { ...input, updatedAt: new Date() },
      });
    await tx
      .insert(jobStatusHistory)
      .values({ userId, jobId: id, status: input.status });
  });
  return input;
}
export async function setArchived(userId: string, id: string, body: unknown) {
  const input = archiveSchema.parse(body);
  await getJob(userId, id);
  const [job] = await getDb()
    .update(jobs)
    .set({
      archivedAt: input.archived ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id))
    .returning();
  return job;
}
export async function dashboardCounts(userId: string) {
  const db = getDb();
  const countries = await countryCondition(userId);
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      newToday: sql<number>`count(*) FILTER (WHERE ${jobs.discoveredAt} >= date_trunc('day', now()))::int`,
    })
    .from(jobs)
    .where(and(visibleJob(userId), activeJob(), countries));
  const [saved] = await db
    .select({
      saved: sql<number>`count(*) FILTER (WHERE status='Saved')::int`,
      applications: sql<number>`count(*) FILTER (WHERE status IN ('Applied','Interviewing','Offer','Preparing Application'))::int`,
    })
    .from(savedJobs)
    .innerJoin(jobs, eq(jobs.id, savedJobs.jobId))
    .where(and(eq(savedJobs.userId, userId), activeJob(), countries));
  return { ...counts, ...saved };
}
