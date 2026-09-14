import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  isoDate,
  type ConnectorOptions,
  type SearchCursor,
  type SourceConnector,
} from "../index";

const reference = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  absolute_url: z.string(),
});

const rawJob = reference.extend({
  company_name: z.string().optional().default(""),
  content: z.string().optional().default(""),
  first_published: z.string().optional().nullable(),
  updated_at: z.string().optional().nullable(),
  location: z
    .object({ name: z.string().optional().default("") })
    .optional()
    .nullable(),
  offices: z
    .array(z.object({ name: z.string().optional().default("") }))
    .optional()
    .default([]),
});

const list = z.object({ jobs: z.array(rawJob) });
const boardUrl = (board: string) =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`;

function cursorFrom(response: {
  etag?: string;
  lastModified?: string;
}): SearchCursor | undefined {
  return response.etag || response.lastModified
    ? { etag: response.etag, lastModified: response.lastModified }
    : undefined;
}

export function createGreenhouseConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "Greenhouse",
    async search(query, previous, signal) {
      const url = new URL(boardUrl(query.board));
      url.searchParams.set("content", "true");
      const headers: Record<string, string> = {};
      if (previous?.etag) headers["If-None-Match"] = previous.etag;
      if (previous?.lastModified)
        headers["If-Modified-Since"] = previous.lastModified;
      const response = await fetchJson(url, { ...options, signal }, headers);
      if (response.status === 304)
        return { jobs: [], complete: true, notModified: true };
      const data = list.parse(response.data);
      for (const job of data.jobs) cache.set(String(job.id), job);
      return {
        jobs: data.jobs.map((job) => ({
          externalId: String(job.id),
          url: job.absolute_url,
          board: query.board,
          company: query.company,
        })),
        next: cursorFrom(response),
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      if (!reference.board) throw new Error("Greenhouse board is required");
      const cached = cache.get(reference.externalId);
      if (cached) return cached;
      const url = new URL(
        `${boardUrl(reference.board)}/${encodeURIComponent(reference.externalId)}`,
      );
      const headers: Record<string, string> | undefined = reference.etag
        ? { "If-None-Match": reference.etag }
        : undefined;
      const response = await fetchJson(url, { ...options, signal }, headers);
      if (response.status === 304)
        throw new Error("Greenhouse job changed unexpectedly during a scan");
      return rawJob.parse(response.data);
    },
    async normalize(raw, context) {
      const location =
        raw.location?.name ||
        raw.offices
          .map((office) => office.name)
          .filter(Boolean)
          .join("; ");
      const description = htmlToText(raw.content);
      const input = jobInputSchema.parse({
        title: raw.title,
        company:
          raw.company_name || context.query.company || context.query.board,
        description,
        location,
        country: "",
        industry: "",
        employmentType: "Unknown",
        seniority: "Unknown",
        workType: /remote/i.test(location) ? "Remote" : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.absolute_url,
        postedAt: isoDate(raw.first_published ?? raw.updated_at),
      });
      return {
        ...input,
        externalId: String(raw.id),
        provider: "Greenhouse" as const,
        sourceUrl: raw.absolute_url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
