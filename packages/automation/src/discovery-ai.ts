import { and, eq, gte, sql } from "drizzle-orm";
import { activityEvents, jobMatches, preferences } from "@jobfinder/db";
import {
  AppError,
  defaultPreferences,
  preferencesSchema,
} from "@jobfinder/shared";
import { createPageExtractor } from "@jobfinder/discovery";
import { recordActivity, type ActivityInput } from "./activity";
import type { AutomationDb } from "./scan";

/** Conservative per-call estimate, retained for failures too. This is not a billing cap. */
export function discoveryExtractor(
  db: AutomationDb,
  userId: string,
  context: Pick<ActivityInput, "sourceId" | "runId" | "actor">,
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {},
) {
  return createPageExtractor({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? "",
    fetchImpl: options.fetchImpl,
    model: process.env.OPENAI_EXPLANATION_MODEL ?? "gpt-5.4-mini",
    beforeCall: async () => {
      const now = new Date();
      const month = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('jobfinder:discovery-budget'), hashtext(${userId}))`,
        );
        const [pref] = await tx
          .select()
          .from(preferences)
          .where(eq(preferences.userId, userId));
        const settings = preferencesSchema.parse(
          pref?.data ?? defaultPreferences,
        );
        const [matches] = await tx
          .select({
            spent: sql<string>`coalesce(sum(${jobMatches.estimatedCostMicros}), 0)::bigint`,
          })
          .from(jobMatches)
          .where(
            and(
              eq(jobMatches.userId, userId),
              gte(jobMatches.evaluatedAt, month),
            ),
          );
        const [discovery] = await tx
          .select({
            spent: sql<string>`coalesce(sum(${activityEvents.estimatedCostMicros}), 0)::bigint`,
          })
          .from(activityEvents)
          .where(
            and(
              eq(activityEvents.userId, userId),
              gte(activityEvents.createdAt, month),
            ),
          );
        const estimate = 50_000;
        if (
          Number(matches.spent) + Number(discovery.spent) + estimate >
          settings.aiMonthlyBudgetMicros
        )
          throw new AppError(
            429,
            "AI careers extraction would exceed your estimated monthly AI budget.",
          );
        await recordActivity(tx, {
          ...context,
          userId,
          actor: context.actor,
          stage: "ai-budget",
          message:
            "AI extraction requested; reserving an estimated $0.05 against the monthly AI budget (default model pricing).",
          estimatedCostMicros: estimate,
        });
      });
    },
  });
}
