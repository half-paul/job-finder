import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  jobReferences,
  jobSources,
  jobs,
  searchRuns,
} from "@jobfinder/db";
import { sourceInputSchema } from "@jobfinder/shared";
import {
  createConnector,
  providerName,
  type JobReference,
  type NormalizedJob,
  type SearchCursor,
} from "@jobfinder/job-sources";
import { canonicalUrl, digest } from "./security";
import { HttpError } from "./http";

export async function listSources(userId: string) {
  const db = getDb();
  const sources = await db
    .select()
    .from(jobSources)
    .where(eq(jobSources.ownerId, userId))
    .orderBy(desc(jobSources.enabled), jobSources.provider, jobSources.board);
  if (!sources.length) return [];
  const runs = await db
    .select()
    .from(searchRuns)
    .where(
      inArray(
        searchRuns.sourceId,
        sources.map((source) => source.id),
      ),
    )
    .orderBy(desc(searchRuns.startedAt));
  return sources.map((source) => ({
    source,
    lastRun:
      runs.find(
        (run) => run.sourceId === source.id && run.status === "Succeeded",
      ) ??
      runs.find((run) => run.sourceId === source.id) ??
      null,
  }));
}

export async function createSource(userId: string, body: unknown) {
  const input = sourceInputSchema.parse(body);
  const identity =
    input.provider === "JSON-LD" && input.sourceUrl
      ? canonicalUrl(input.sourceUrl)
      : `${input.provider}:${input.board}`;
  const allowedHosts = (process.env.JSON_LD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (input.provider === "JSON-LD") {
    if (!allowedHosts.length)
      throw new HttpError(
        400,
        "Configure JSON_LD_ALLOWED_HOSTS before adding a JSON-LD source.",
      );
    const hostname = new URL(input.sourceUrl!).hostname.toLowerCase();
    const permitted = allowedHosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
    if (!permitted)
      throw new HttpError(400, "That JSON-LD host is not allowlisted.");
  }
  const [source] = await getDb()
    .insert(jobSources)
    .values({
      ownerId: userId,
      identity,
      company: input.company,
      provider: input.provider,
      board:
        input.provider === "RemoteOK" ? "remoteok" : input.board || "json-ld",
      sourceUrl:
        input.provider === "JSON-LD" ? canonicalUrl(input.sourceUrl!) : null,
      enabled: true,
    })
    .onConflictDoNothing()
    .returning();
  if (!source) throw new HttpError(409, "That source has already been added.");
  return source;
}

export async function scanSource(userId: string, sourceId: string) {
  const db = getDb();
  const [source] = await db
    .select()
    .from(jobSources)
    .where(and(eq(jobSources.id, sourceId), eq(jobSources.ownerId, userId)));
  if (!source) throw new HttpError(404, "Source not found.");

  const [run] = await db
    .insert(searchRuns)
    .values({ sourceId: source.id, userId, status: "Running" })
    .returning();
  try {
    const provider = providerName(source.provider);
    const connector = createConnector(provider, {
      jsonLdAllowedHosts: (process.env.JSON_LD_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    });
    const query = {
      board: source.board,
      terms: [],
      company: source.company,
      sourceUrl: source.sourceUrl ?? undefined,
    };
    const initialCursor: SearchCursor | undefined =
      source.etag || source.lastModified
        ? {
            etag: source.etag ?? undefined,
            lastModified: source.lastModified ?? undefined,
          }
        : undefined;
    let page = await connector.search(query, initialCursor);
    const warnings: string[] = [];
    const seen: string[] = [];
    let added = 0;
    let updated = 0;
    let discovered = 0;
    let cursor = page.next;
    const maxJobs = 5000;

    while (true) {
      if (!page.notModified) {
        discovered += page.jobs.length;
        for (const reference of page.jobs) {
          const fullReference: JobReference = {
            ...reference,
            board: source.board,
            company: source.company,
            sourceUrl: source.sourceUrl ?? undefined,
          };
          seen.push(reference.externalId);
          try {
            const raw = await connector.fetchJob(fullReference);
            const normalized = await connector.normalize(raw, { query });
            const result = await upsertDiscoveredJob(
              userId,
              source.id,
              normalized,
            );
            if (result === "added") added++;
            if (result === "updated") updated++;
          } catch (error) {
            warnings.push(
              `${reference.externalId}: ${
                error instanceof Error
                  ? error.message
                  : "could not normalize job"
              }`,
            );
          }
        }
      }
      const complete = page.complete || page.notModified;
      if (!complete && (!cursor || seen.length >= maxJobs)) {
        const [partial] = await db
          .update(searchRuns)
          .set({
            status: "Partial",
            finishedAt: new Date(),
            discovered,
            added,
            updated,
            removed: 0,
            warnings: [
              cursor
                ? `Scan stopped at the ${maxJobs}-job safety cap; no removals were marked.`
                : "Source returned an incomplete page without a continuation cursor; no removals were marked.",
              ...warnings.slice(0, 99),
            ],
          })
          .where(eq(searchRuns.id, run.id))
          .returning();
        return partial;
      }
      if (complete) break;
      page = await connector.search(query, cursor);
      cursor = page.next;
    }

    if (!page.notModified) {
      const removed = await deactivateMissingReferences(source.id, seen);
      await db
        .update(jobSources)
        .set({
          etag: page.next?.etag ?? null,
          lastModified: page.next?.lastModified ?? null,
        })
        .where(eq(jobSources.id, source.id));
      const [finished] = await db
        .update(searchRuns)
        .set({
          status: "Succeeded",
          finishedAt: new Date(),
          discovered,
          added,
          updated,
          removed,
          warnings: warnings.slice(0, 100),
        })
        .where(eq(searchRuns.id, run.id))
        .returning();
      return finished;
    }

    const [finished] = await db
      .update(searchRuns)
      .set({
        status: "Succeeded",
        finishedAt: new Date(),
        discovered,
        added,
        updated,
        removed: 0,
        warnings: ["Source was not modified since the previous complete scan."],
      })
      .where(eq(searchRuns.id, run.id))
      .returning();
    return finished;
  } catch (error) {
    await db
      .update(searchRuns)
      .set({
        status: "Failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : "Source scan failed",
      })
      .where(eq(searchRuns.id, run.id));
    throw new HttpError(
      502,
      error instanceof Error ? error.message : "The source scan failed.",
    );
  }
}

async function upsertDiscoveredJob(
  userId: string,
  sourceId: string,
  normalized: NormalizedJob,
): Promise<"added" | "updated" | "unchanged"> {
  const db = getDb();
  const jobUrl = canonicalUrl(normalized.jobUrl);
  const canonicalHash = digest(jobUrl);
  const values = {
    ownerId: userId,
    title: normalized.title,
    company: normalized.company,
    description: normalized.description,
    location: normalized.location,
    country: normalized.country,
    industry: normalized.industry,
    employmentType: normalized.employmentType,
    seniority: normalized.seniority,
    workType: normalized.workType,
    salaryMin: normalized.salaryMin,
    salaryMax: normalized.salaryMax,
    salaryPeriod: normalized.salaryPeriod,
    currency: normalized.currency,
    jobUrl,
    canonicalHash,
    descriptionHash: normalized.descriptionHash,
    source: normalized.provider,
    lifecycle: "Active",
    postedAt: normalized.postedAt ? new Date(normalized.postedAt) : null,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select({
      id: jobs.id,
      descriptionHash: jobs.descriptionHash,
    })
    .from(jobs)
    .where(
      and(eq(jobs.ownerId, userId), eq(jobs.canonicalHash, canonicalHash)),
    );
  let jobId = existing?.id;
  if (!existing) {
    const [job] = await db
      .insert(jobs)
      .values(values)
      .returning({ id: jobs.id });
    jobId = job.id;
  } else if (existing.descriptionHash !== normalized.descriptionHash) {
    await db.update(jobs).set(values).where(eq(jobs.id, existing.id));
  } else {
    await db
      .update(jobs)
      .set({ lastSeenAt: new Date(), lifecycle: "Active" })
      .where(eq(jobs.id, existing.id));
  }
  await db
    .insert(jobReferences)
    .values({
      jobId,
      sourceId,
      externalId: normalized.externalId,
      url: normalized.sourceUrl,
      active: true,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [jobReferences.sourceId, jobReferences.externalId],
      set: {
        jobId,
        active: true,
        url: normalized.sourceUrl,
        lastSeenAt: new Date(),
      },
    });
  return !existing
    ? "added"
    : existing.descriptionHash === normalized.descriptionHash
      ? "unchanged"
      : "updated";
}

async function deactivateMissingReferences(sourceId: string, seen: string[]) {
  const db = getDb();
  const active = await db
    .select({
      jobId: jobReferences.jobId,
      externalId: jobReferences.externalId,
    })
    .from(jobReferences)
    .where(
      and(eq(jobReferences.sourceId, sourceId), eq(jobReferences.active, true)),
    );
  const missing = active.filter(
    (reference) => !seen.includes(reference.externalId),
  );
  for (const reference of missing) {
    await db
      .update(jobReferences)
      .set({ active: false, lastSeenAt: new Date() })
      .where(
        and(
          eq(jobReferences.sourceId, sourceId),
          eq(jobReferences.externalId, reference.externalId),
        ),
      );
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobReferences)
      .where(
        and(
          eq(jobReferences.jobId, reference.jobId),
          eq(jobReferences.active, true),
        ),
      );
    if (count === 0)
      await db
        .update(jobs)
        .set({
          lifecycle: "Removed",
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, reference.jobId));
  }
  return missing.length;
}
