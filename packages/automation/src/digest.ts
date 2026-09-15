import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { jobMatches, jobs, preferences, savedJobs } from "@jobfinder/db";
import {
  defaultPreferences,
  digestRequestSchema,
  matchBand,
  preferencesSchema,
  type MatchBand,
} from "@jobfinder/shared";
import { createNarrative } from "@jobfinder/matching";
import { digestNotificationKey, insertNotifications } from "./notifications";
import { recordState } from "./schedule";
import type { AutomationDb } from "./scan";

export interface DigestItem {
  jobId: string;
  title: string;
  company: string;
  location: string;
  workType: string;
  score: number;
  band: MatchBand;
}

export interface DigestSummary {
  generatedAt: string;
  windowHours: number;
  windowFrom: string;
  newJobs: number;
  counts: {
    excellent: number;
    strong: number;
    possible: number;
    highPriority: number;
  };
  top: DigestItem[];
  applications: Array<{
    jobId: string;
    title: string;
    company: string;
    status: string;
  }>;
  narrative: string | null;
}

export const digestStateKey = (userId: string) => `digest:${userId}`;

/**
 * Counts and ordering stay deterministic; the model, when the user asks for it,
 * only writes the summary sentence from these numbers.
 */
export async function buildDigest(
  userId: string,
  options: { db: AutomationDb; windowHours?: number; now?: Date },
): Promise<DigestSummary> {
  const { db } = options;
  const now = options.now ?? new Date();
  const windowHours = Math.min(Math.max(options.windowHours ?? 24, 1), 24 * 30);
  const windowFrom = new Date(now.getTime() - windowHours * 3_600_000);
  const [preferenceRow] = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId));
  const settings = preferencesSchema.parse(
    preferenceRow?.data ?? defaultPreferences,
  );

  const [newJobs] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(
        sql`(${jobs.ownerId} IS NULL OR ${jobs.ownerId} = ${userId})`,
        isNull(jobs.archivedAt),
        sql`${jobs.discoveredAt} >= ${windowFrom}`,
      ),
    );

  const scored = await db
    .select({
      jobId: jobMatches.jobId,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      workType: jobs.workType,
      score: sql<number>`(${jobMatches.data}->>'overallScore')::int`,
    })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .where(
      and(
        eq(jobMatches.userId, userId),
        isNull(jobs.archivedAt),
        sql`${jobMatches.evaluatedAt} >= ${windowFrom}`,
      ),
    )
    .orderBy(desc(sql`(${jobMatches.data}->>'overallScore')::numeric`))
    .limit(50);

  const items: DigestItem[] = scored.map((row) => ({
    jobId: row.jobId,
    title: row.title,
    company: row.company,
    location: row.location,
    workType: row.workType,
    score: row.score,
    band: matchBand(row.score),
  }));
  const counts = {
    excellent: items.filter((item) => item.score >= settings.notifyMinScore)
      .length,
    strong: items.filter(
      (item) =>
        item.score >= settings.digestMinScore &&
        item.score < settings.notifyMinScore,
    ).length,
    possible: items.filter(
      (item) => item.score >= 65 && item.score < settings.digestMinScore,
    ).length,
    highPriority: items.filter((item) => item.score >= 90).length,
  };

  const applications = await db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      company: jobs.company,
      status: savedJobs.status,
    })
    .from(savedJobs)
    .innerJoin(jobs, eq(jobs.id, savedJobs.jobId))
    .where(
      and(
        eq(savedJobs.userId, userId),
        isNull(jobs.archivedAt),
        sql`${savedJobs.status} IN ('Preparing Application','Applied','Interviewing','Offer')`,
      ),
    )
    .orderBy(desc(savedJobs.updatedAt))
    .limit(10);

  const top = items
    .filter((item) => item.score >= settings.digestMinScore)
    .slice(0, 5);

  return {
    generatedAt: now.toISOString(),
    windowHours,
    windowFrom: windowFrom.toISOString(),
    newJobs: newJobs.count,
    counts,
    top,
    applications,
    narrative: null,
  };
}

/**
 * Generates the digest and records it as an in-app notification. Prose is
 * opt-in and falls back to deterministic text, so an unavailable model never
 * blocks the digest itself. No email or outbound message is ever sent here.
 */
export async function generateDigest(
  userId: string,
  options: {
    db: AutomationDb;
    body?: unknown;
    windowHours?: number;
    now?: Date;
  },
) {
  const input = digestRequestSchema.parse(options.body ?? {});
  const summary = await buildDigest(userId, {
    db: options.db,
    windowHours: options.windowHours,
    now: options.now,
  });
  let narrative = deterministicNarrative(summary);
  let usage: {
    inputTokens: number;
    outputTokens: number;
    embeddingTokens: number;
    estimatedCostMicros: number;
  } | null = null;
  if (input.narrative) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey)
      try {
        const written = await createNarrative(
          {
            newJobs: summary.newJobs,
            counts: summary.counts,
            top: summary.top.map((item) => ({
              title: item.title,
              company: item.company,
              score: item.score,
            })),
          },
          {
            apiKey,
            model: process.env.OPENAI_EXPLANATION_MODEL ?? "gpt-5.4-mini",
          },
        );
        narrative = written.text;
        usage = written.usage;
      } catch {
        // Deterministic text already covers the digest; the model is optional.
      }
  }
  const at = options.now ?? new Date();
  const body = [narrative, ...summary.top.map(summarizeItem)].join("\n");
  await insertNotifications(options.db, [
    {
      userId,
      jobId: null,
      kind: "Digest",
      title: `${summary.newJobs} new ${summary.newJobs === 1 ? "opportunity" : "opportunities"} in the last ${summary.windowHours} hours`,
      body: body.slice(0, 4000),
      score: summary.top[0]?.score ?? null,
      dedupeKey: digestNotificationKey(at),
    },
  ]);
  await recordState(options.db, digestStateKey(userId), {
    generatedAt: at.toISOString(),
    windowHours: summary.windowHours,
  });
  return {
    digest: { ...summary, narrative } satisfies DigestSummary,
    usage,
  };
}

const summarizeItem = (item: DigestItem) =>
  `• ${item.title} — ${item.company} (${item.score}, ${item.band})`;

function deterministicNarrative(summary: DigestSummary) {
  const parts = [
    `${summary.newJobs} new ${summary.newJobs === 1 ? "opportunity" : "opportunities"} discovered in the last ${summary.windowHours} hours.`,
  ];
  if (
    summary.counts.highPriority ||
    summary.counts.strong ||
    summary.counts.possible
  )
    parts.push(
      `${summary.counts.highPriority} high-priority, ${summary.counts.strong} strong and ${summary.counts.possible} possible matches were evaluated.`,
    );
  else
    parts.push("No evaluated opportunity reached your digest threshold yet.");
  if (summary.applications.length)
    parts.push(
      `${summary.applications.length} ${summary.applications.length === 1 ? "application needs" : "applications need"} your attention.`,
    );
  return parts.join(" ");
}

/** Users whose daily digest hour has arrived and who opted in. */
export async function digestDueUsers(db: AutomationDb, now = new Date()) {
  const rows = await db.select().from(preferences);
  return rows
    .filter((row) => {
      const settings = preferencesSchema.safeParse(row.data);
      if (!settings.success || !settings.data.digestEnabled) return false;
      return settings.data.digestHourUtc === now.getUTCHours();
    })
    .map((row) => row.userId);
}
