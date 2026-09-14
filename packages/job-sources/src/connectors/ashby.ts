import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const rawJob = z.object({
  title: z.string(),
  location: z.string().optional().default(""),
  department: z.string().optional().default(""),
  workplaceType: z
    .enum(["OnSite", "Remote", "Hybrid"])
    .optional()
    .default("OnSite"),
  descriptionHtml: z.string().optional().default(""),
  descriptionPlain: z.string().optional().default(""),
  publishedAt: z.string().optional().nullable(),
  employmentType: z
    .enum(["FullTime", "PartTime", "Intern", "Contract", "Temporary"])
    .optional()
    .default("FullTime"),
  jobUrl: z.string(),
  applyUrl: z.string().optional().default(""),
  compensation: z
    .object({
      summaryComponents: z
        .array(
          z.object({
            compensationType: z.string(),
            interval: z.string(),
            currencyCode: z.string().optional().nullable(),
            minValue: z.number().optional().nullable(),
            maxValue: z.number().optional().nullable(),
          }),
        )
        .optional()
        .default([]),
    })
    .optional()
    .nullable(),
});

const list = z.object({ jobs: z.array(rawJob) });
const employment = {
  FullTime: "Full-time",
  PartTime: "Temporary",
  Intern: "Temporary",
  Contract: "Contract",
  Temporary: "Temporary",
} as const;

export function createAshbyConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "Ashby",
    async search(query, cursor, signal) {
      const url = new URL(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(query.board)}`,
      );
      url.searchParams.set("includeCompensation", "true");
      const headers: Record<string, string> = {};
      if (cursor?.etag) headers["If-None-Match"] = cursor.etag;
      if (cursor?.lastModified)
        headers["If-Modified-Since"] = cursor.lastModified;
      const response = await fetchJson(url, { ...options, signal }, headers);
      if (response.status === 304)
        return { jobs: [], complete: true, notModified: true };
      const data = list.parse(response.data);
      for (const job of data.jobs) cache.set(job.jobUrl, job);
      return {
        jobs: data.jobs.map((job) => ({
          externalId: job.jobUrl,
          url: job.jobUrl,
          board: query.board,
          company: query.company,
        })),
        next:
          response.etag || response.lastModified
            ? { etag: response.etag, lastModified: response.lastModified }
            : undefined,
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      if (!reference.board) throw new Error("Ashby board is required");
      const cached = cache.get(reference.externalId);
      if (cached) return cached;
      const url = new URL(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(reference.board)}`,
      );
      url.searchParams.set("includeCompensation", "true");
      const response = await fetchJson(url, { ...options, signal });
      if (response.status === 304)
        throw new Error("Ashby job changed unexpectedly during a scan");
      const data = list.parse(response.data);
      const job = data.jobs.find(
        (candidate) => candidate.jobUrl === reference.externalId,
      );
      if (!job) throw new Error("Ashby job is no longer published");
      return job;
    },
    async normalize(raw, context) {
      const description =
        raw.descriptionPlain || htmlToText(raw.descriptionHtml);
      const salary = raw.compensation?.summaryComponents.find(
        (component) => component.compensationType === "Salary",
      );
      const input = jobInputSchema.parse({
        title: raw.title,
        company: context.query.company || context.query.board,
        description,
        location: raw.location,
        country: "",
        industry: raw.department,
        employmentType: employment[raw.employmentType],
        seniority: "Unknown",
        workType:
          raw.workplaceType === "Remote"
            ? "Remote"
            : raw.workplaceType === "Hybrid"
              ? "Hybrid"
              : "On-site",
        salaryMin: salary?.minValue ?? null,
        salaryMax: salary?.maxValue ?? null,
        salaryPeriod: salary?.interval === "1 YEAR" ? "year" : "unknown",
        currency: salary?.currencyCode ?? "Unknown",
        jobUrl: raw.jobUrl,
        postedAt: isoDate(raw.publishedAt),
      });
      return {
        ...input,
        externalId: raw.jobUrl,
        provider: "Ashby" as const,
        sourceUrl: raw.jobUrl,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
