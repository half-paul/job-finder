import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const rawJob = z.object({
  id: z.string(),
  text: z.string(),
  categories: z
    .object({
      location: z.string().optional(),
      commitment: z.string().optional(),
    })
    .optional(),
  country: z.string().optional().nullable(),
  descriptionPlain: z.string().optional().default(""),
  description: z.string().optional().default(""),
  hostedUrl: z.string(),
  workplaceType: z
    .enum(["unspecified", "on-site", "onsite", "remote", "hybrid"])
    .optional()
    .default("unspecified"),
  salaryRange: z
    .object({
      currency: z.string().optional().nullable(),
      interval: z.string().optional().nullable(),
      min: z.number().optional().nullable(),
      max: z.number().optional().nullable(),
    })
    .optional()
    .nullable(),
});

const list = z.array(rawJob);
const pageSize = 100;

export function createLeverConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "Lever",
    async search(query, cursor, signal) {
      const skip = Math.max(0, Number(cursor?.cursor ?? 0) || 0);
      const url = new URL(
        `https://api.lever.co/v0/postings/${encodeURIComponent(query.board)}`,
      );
      url.searchParams.set("mode", "json");
      url.searchParams.set("skip", String(skip));
      url.searchParams.set("limit", String(pageSize));
      const response = await fetchJson(url, { ...options, signal });
      const jobs = list.parse(response.data);
      for (const job of jobs) cache.set(job.id, job);
      const hasMore = jobs.length === pageSize;
      return {
        jobs: jobs.map((job) => ({
          externalId: job.id,
          url: job.hostedUrl,
          board: query.board,
          company: query.company,
        })),
        next: hasMore
          ? {
              cursor: String(skip + pageSize),
              etag: response.etag,
              lastModified: response.lastModified,
            }
          : undefined,
        complete: !hasMore,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      if (!reference.board) throw new Error("Lever site name is required");
      const cached = cache.get(reference.externalId);
      if (cached) return cached;
      const url = new URL(
        `https://api.lever.co/v0/postings/${encodeURIComponent(reference.board)}/${encodeURIComponent(reference.externalId)}`,
      );
      const response = await fetchJson(url, { ...options, signal });
      return rawJob.parse(response.data);
    },
    async normalize(raw, context) {
      const description = raw.descriptionPlain || htmlToText(raw.description);
      const workType =
        raw.workplaceType === "remote"
          ? "Remote"
          : raw.workplaceType === "hybrid"
            ? "Hybrid"
            : raw.workplaceType === "on-site" || raw.workplaceType === "onsite"
              ? "On-site"
              : "Unknown";
      const interval = raw.salaryRange?.interval?.toLowerCase();
      const input = jobInputSchema.parse({
        title: raw.text,
        company: context.query.company || context.query.board,
        description,
        location: raw.categories?.location ?? "",
        country: raw.country ?? "",
        industry: "",
        employmentType: /contract/i.test(raw.categories?.commitment ?? "")
          ? "Contract"
          : /part/i.test(raw.categories?.commitment ?? "")
            ? "Temporary"
            : /full/i.test(raw.categories?.commitment ?? "")
              ? "Full-time"
              : "Unknown",
        seniority: "Unknown",
        workType,
        salaryMin: raw.salaryRange?.min ?? null,
        salaryMax: raw.salaryRange?.max ?? null,
        salaryPeriod:
          interval === "year" ||
          interval === "hour" ||
          interval === "month" ||
          interval === "week" ||
          interval === "day"
            ? interval
            : "unknown",
        currency: raw.salaryRange?.currency ?? "Unknown",
        jobUrl: raw.hostedUrl,
        postedAt: null,
      });
      return {
        ...input,
        externalId: raw.id,
        provider: "Lever" as const,
        sourceUrl: raw.hostedUrl,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
