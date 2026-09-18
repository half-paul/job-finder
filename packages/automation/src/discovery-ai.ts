import { and, eq, gte, sql } from "drizzle-orm";
import { activityEvents, preferences } from "@jobfinder/db";
import {
  AppError,
  defaultPreferences,
  preferencesSchema,
} from "@jobfinder/shared";
import { createPageExtractor } from "@jobfinder/discovery";
import { estimateCostMicros } from "@jobfinder/matching";
import type { ActivityInput } from "./activity";
import type { AutomationDb } from "./scan";

/** Reserved per call before the request, then settled against real usage. */
const discoveryCallEstimateMicros = 50_000;

/**
 * Wraps the page extractor in a per-user monthly budget gate. The reservation
 * is written before the request and settled afterwards from the tokens the
 * provider reports, so a failed call costs nothing and a cheap call does not
 * keep charging the flat estimate. Throws AppError 429 when the budget is
 * already spent. This is an estimate check, not a billing cap.
 */
export function discoveryExtractor(
  db: AutomationDb,
  userId: string,
  context: Pick<ActivityInput, "sourceId" | "runId" | "actor">,
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {},
) {
  // Reservations are settled in the order they were made; the adaptive
  // connector issues extraction calls one at a time.
  const reserved: string[] = [];
  return createPageExtractor({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? "",
    fetchImpl: options.fetchImpl,
    model: process.env.OPENAI_EXPLANATION_MODEL ?? "gpt-5.4-mini",
    afterCall: async ({ usage, failed }) => {
      const id = reserved.shift();
      if (!id) return;
      // Only a failed call is released. A call that succeeded without usage
      // reporting still spent money, so it keeps the conservative estimate.
      const settled = failed
        ? 0
        : usage
          ? estimateCostMicros({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              embeddingTokens: 0,
            })
          : discoveryCallEstimateMicros;
      await db
        .update(activityEvents)
        .set({
          estimatedCostMicros: settled,
          message: failed
            ? "AI extraction failed; the reserved budget was released."
            : `AI extraction charged $${(settled / 1_000_000).toFixed(4)} against the monthly discovery budget${usage ? "" : " (provider reported no usage; the estimate stands)"}.`,
        })
        .where(eq(activityEvents.id, id));
    },
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
        if (
          Number(discovery.spent) + discoveryCallEstimateMicros >
          settings.aiDiscoveryBudgetMicros
        )
          throw new AppError(
            429,
            "AI careers extraction would exceed your estimated monthly discovery budget.",
          );
        const [row] = await tx
          .insert(activityEvents)
          .values({
            ...context,
            userId,
            actor: context.actor,
            stage: "ai-budget",
            message: `AI extraction requested; reserving an estimated $${(
              discoveryCallEstimateMicros / 1_000_000
            ).toFixed(2)} against the monthly discovery budget.`,
            estimatedCostMicros: discoveryCallEstimateMicros,
          })
          .returning({ id: activityEvents.id });
        reserved.push(row.id);
      });
    },
  });
}
