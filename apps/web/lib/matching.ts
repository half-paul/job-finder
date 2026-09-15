import "server-only";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  getPool,
  searchRuns,
  jobReferences,
  jobEmbeddings,
  jobMatches,
  jobs,
  profiles,
  preferences,
  targetEmbeddings,
} from "@jobfinder/db";
import {
  defaultPreferences,
  emptyProfile,
  jobInputSchema,
  preferencesSchema,
  profileSchema,
} from "@jobfinder/shared";
import {
  aggregateScores,
  approximateTokens,
  buildJobText,
  buildTargetText,
  cosineSimilarity,
  createEmbedding,
  createStructuredEvaluation,
  estimateCostMicros,
  hardFilter,
  type EvaluationFactors,
} from "@jobfinder/matching";
import { visibleJob } from "./jobs";
import { HttpError } from "./http";
import { digest } from "./security";

const explanationVersion = "openai:gpt-5.4-mini:structured:v1";

function apiKey() {
  const value = process.env.OPENAI_API_KEY;
  if (!value) throw new HttpError(503, "AI matching is not configured.");
  return value;
}

function monthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type EvaluationDb = NodePgDatabase;

async function withEvaluationLock<T>(
  userId: string,
  action: (db: EvaluationDb) => Promise<T>,
) {
  const client = await getPool().connect();
  let locked = false;
  let releaseError: Error | undefined;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('jobfinder:evaluation'), hashtext($1)) AS locked",
      [userId],
    );
    locked = result.rows[0].locked;
    if (!locked)
      throw new HttpError(
        409,
        "An evaluation is already running in your workspace.",
      );
    return await action(drizzle(client));
  } finally {
    if (locked) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('jobfinder:evaluation'), hashtext($1))",
          [userId],
        );
      } catch (error) {
        releaseError =
          error instanceof Error
            ? error
            : new Error("Could not release evaluation lock");
      }
    }
    client.release(releaseError);
  }
}

export async function evaluateJob(userId: string, jobId: string) {
  return withEvaluationLock(userId, (db) =>
    evaluateJobWithDb(userId, jobId, db),
  );
}

async function evaluateJobWithDb(
  userId: string,
  jobId: string,
  db: EvaluationDb,
) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), visibleJob(userId)));
  if (!job) throw new HttpError(404, "Opportunity not found.");

  const [profileRow] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId));
  const [preferencesRow] = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId));
  const profile = profileSchema.parse(profileRow?.data ?? emptyProfile);
  const careerPreferences = preferencesSchema.parse(
    preferencesRow?.data ?? defaultPreferences,
  );
  if (!profile.currentRole || !profile.summary || profile.skills.length === 0)
    throw new HttpError(
      400,
      "Add your current role, summary and skills before requesting an AI evaluation.",
    );

  const jobInput = jobInputSchema.parse({
    ...job,
    postedAt: job.postedAt ? job.postedAt.toISOString() : null,
  });
  const blocked = hardFilter(jobInput, careerPreferences);
  if (!blocked.passed) return { match: null, blocked, usage: null };

  const targetText = buildTargetText(profile, careerPreferences);
  const jobText = buildJobText(jobInput).slice(0, 32000);
  const embeddingModel =
    process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const explanationModel =
    process.env.OPENAI_EXPLANATION_MODEL ?? "gpt-5.4-mini";
  const modelKey = `openai:${embeddingModel}:1536:v1`;

  const estimatedInputTokens = approximateTokens(targetText, jobText) + 200;
  const estimatedEmbeddingTokens = approximateTokens(targetText, jobText);
  const estimatedCost = estimateCostMicros({
    inputTokens: estimatedInputTokens,
    outputTokens: 700,
    embeddingTokens: estimatedEmbeddingTokens,
  });
  const [spend] = await db
    .select({
      spent: sql<number>`coalesce(sum(${jobMatches.estimatedCostMicros}), 0)::int`,
    })
    .from(jobMatches)
    .where(
      and(
        eq(jobMatches.userId, userId),
        gte(jobMatches.evaluatedAt, monthStart()),
      ),
    );
  if (spend.spent + estimatedCost > careerPreferences.aiMonthlyBudgetMicros)
    throw new HttpError(
      429,
      "This evaluation would exceed your monthly AI budget. Increase the budget or wait for the next month.",
    );

  const target = await ensureTargetEmbedding(
    db,
    userId,
    targetText,
    modelKey,
    embeddingModel,
  );
  const jobVector = await ensureJobEmbedding(
    db,
    jobId,
    jobText,
    modelKey,
    embeddingModel,
  );
  const semanticSimilarity = cosineSimilarity(
    target.embedding,
    jobVector.embedding,
  );
  const ai = await createStructuredEvaluation(
    {
      profile,
      preferences: careerPreferences,
      job: jobInput,
      semanticSimilarity,
    },
    {
      apiKey: apiKey(),
      model: explanationModel,
    },
  );

  const factors: EvaluationFactors = {
    ...ai.evaluation.factors,
    role:
      ai.evaluation.factors.role * 0.6 + ((semanticSimilarity + 1) / 2) * 0.4,
  };
  const aggregate = aggregateScores(factors, careerPreferences.weights);
  const { qualificationScore, interestScore } = aggregate;
  if (qualificationScore === null || interestScore === null)
    throw new HttpError(
      400,
      "Your weights must include both qualification and interest factors before AI evaluation.",
    );
  const match = {
    ...aggregate,
    qualificationScore,
    interestScore,
    confidence: ai.evaluation.confidence,
    reasons: ai.evaluation.reasons,
    gaps: ai.evaluation.gaps,
    progression: ai.evaluation.progression,
  };
  const usage = {
    inputTokens: ai.usage.inputTokens,
    outputTokens: ai.usage.outputTokens,
    embeddingTokens: target.usage.prompt_tokens + jobVector.usage.prompt_tokens,
    estimatedCostMicros: 0,
  };
  usage.estimatedCostMicros = estimateCostMicros(usage);

  await db
    .insert(jobMatches)
    .values({
      userId,
      jobId,
      data: match,
      version: explanationVersion,
      ...usage,
      evaluatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [jobMatches.userId, jobMatches.jobId],
      set: {
        data: match,
        version: explanationVersion,
        ...usage,
        evaluatedAt: new Date(),
      },
    });

  return {
    match,
    blocked: null,
    usage: { ...usage, semanticSimilarity },
  };
}

async function ensureTargetEmbedding(
  db: EvaluationDb,
  userId: string,
  text: string,
  modelKey: string,
  model: string,
) {
  const contentHash = digest(text);
  const [existing] = await db
    .select()
    .from(targetEmbeddings)
    .where(
      and(
        eq(targetEmbeddings.userId, userId),
        eq(targetEmbeddings.model, modelKey),
      ),
    );
  if (existing?.contentHash === contentHash)
    return { embedding: existing.embedding, usage: { prompt_tokens: 0 } };
  const result = await createEmbedding(text, { apiKey: apiKey(), model });
  await db
    .insert(targetEmbeddings)
    .values({
      userId,
      model: modelKey,
      contentHash,
      embedding: result.embedding,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [targetEmbeddings.userId, targetEmbeddings.model],
      set: {
        contentHash,
        embedding: result.embedding,
        updatedAt: new Date(),
      },
    });
  return result;
}

async function ensureJobEmbedding(
  db: EvaluationDb,
  jobId: string,
  text: string,
  modelKey: string,
  model: string,
) {
  const contentHash = digest(text);
  const [existing] = await db
    .select()
    .from(jobEmbeddings)
    .where(
      and(eq(jobEmbeddings.jobId, jobId), eq(jobEmbeddings.model, modelKey)),
    );
  if (existing?.contentHash === contentHash)
    return { embedding: existing.embedding, usage: { prompt_tokens: 0 } };
  const result = await createEmbedding(text, { apiKey: apiKey(), model });
  await db
    .insert(jobEmbeddings)
    .values({
      jobId,
      model: modelKey,
      contentHash,
      embedding: result.embedding,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [jobEmbeddings.jobId, jobEmbeddings.model],
      set: {
        contentHash,
        embedding: result.embedding,
        updatedAt: new Date(),
      },
    });
  return result;
}

/** One bounded batch after all requested sources have finished syncing. */
export async function evaluateSyncedJobs(userId: string, body: unknown) {
  const { runIds } = z
    .object({ runIds: z.array(z.uuid()).min(1).max(1000) })
    .parse(body);
  return withEvaluationLock(userId, async (db) => {
    const [preferencesRow] = await db
      .select()
      .from(preferences)
      .where(eq(preferences.userId, userId));
    const settings = preferencesSchema.parse(
      preferencesRow?.data ?? defaultPreferences,
    );
    const result = {
      enabled: settings.autoEvaluateAfterSync,
      limit: settings.evaluationBatchSize,
      selected: 0,
      evaluated: 0,
      blocked: 0,
      failed: 0,
      errors: [] as string[],
    };
    const ids = [...new Set(runIds)];
    const runs = await db
      .select()
      .from(searchRuns)
      .where(
        and(
          eq(searchRuns.userId, userId),
          inArray(searchRuns.id, ids),
          inArray(searchRuns.status, ["Succeeded", "Partial"]),
        ),
      );
    if (runs.length !== ids.length)
      throw new HttpError(
        400,
        "Evaluation requires completed scans belonging to your workspace.",
      );
    if (!settings.autoEvaluateAfterSync) return result;
    const sourceIds = [...new Set(runs.map((run) => run.sourceId))];
    const [profileRow] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const changedSince = new Date(
      Math.max(
        preferencesRow?.updatedAt.getTime() ?? 0,
        profileRow?.updatedAt.getTime() ?? 0,
      ),
    );
    const selected: string[] = [];
    const seen = new Set<string>();
    for (
      let offset = 0;
      selected.length < settings.evaluationBatchSize;
      offset += 200
    ) {
      const candidates = await db
        .selectDistinct({ job: jobs })
        .from(jobs)
        .innerJoin(
          jobReferences,
          and(
            eq(jobReferences.jobId, jobs.id),
            eq(jobReferences.active, true),
            inArray(jobReferences.sourceId, sourceIds),
          ),
        )
        .leftJoin(
          jobMatches,
          and(eq(jobMatches.jobId, jobs.id), eq(jobMatches.userId, userId)),
        )
        .where(
          and(
            eq(jobs.ownerId, userId),
            eq(jobs.lifecycle, "Active"),
            isNull(jobs.archivedAt),
            or(
              isNull(jobMatches.jobId),
              sql`${jobMatches.evaluatedAt} < ${jobs.updatedAt}`,
              sql`${jobMatches.evaluatedAt} < ${changedSince}`,
            ),
          ),
        )
        .orderBy(desc(jobs.discoveredAt), jobs.id)
        .limit(200)
        .offset(offset);
      for (const { job } of candidates) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        const input = jobInputSchema.safeParse({
          ...job,
          postedAt: job.postedAt?.toISOString() ?? null,
        });
        if (!input.success || !hardFilter(input.data, settings).passed)
          continue;
        selected.push(job.id);
        if (selected.length === settings.evaluationBatchSize) break;
      }
      if (candidates.length < 200) break;
    }
    result.selected = selected.length;
    for (const id of selected) {
      try {
        const evaluated = await evaluateJobWithDb(userId, id, db);
        if (evaluated.match) result.evaluated++;
        else result.blocked++;
      } catch (error) {
        result.failed++;
        result.errors.push(
          error instanceof Error ? error.message : "Evaluation failed.",
        );
        // Preserve budget and avoid repeatedly calling a failing provider.
        break;
      }
    }
    return result;
  });
}
