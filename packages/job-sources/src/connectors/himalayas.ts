import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  isoDate,
  salaryRange,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const rawJob = z.object({
  guid: z.url(),
  applicationLink: z.url().nullable().optional(),
  title: z.string(),
  companyName: z.string(),
  description: z.string(),
  employmentType: z.string().nullable().optional().default(""),
  minSalary: z.number().nullable().optional(),
  maxSalary: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  salaryPeriod: z.string().nullable().optional(),
  locationRestrictions: z.array(z.string()).nullable().optional().default([]),
  categories: z.array(z.string()).nullable().optional().default([]),
  pubDate: z.number().nullable().optional(),
});

const feed = z.object({ jobs: z.array(z.unknown()) });

const employmentType = (value: string) => {
  const kind = value.toLowerCase();
  if (/contract|freelance/.test(kind)) return "Contract";
  if (/full[ -]?time/.test(kind)) return "Full-time";
  if (/part[ -]?time|intern|temporary/.test(kind)) return "Temporary";
  return "Unknown";
};

const period = (value: string) => {
  const unit = value.toLowerCase();
  if (/year|annual/.test(unit)) return "year";
  if (/hour/.test(unit)) return "hour";
  if (/month/.test(unit)) return "month";
  if (/week/.test(unit)) return "week";
  if (/day/.test(unit)) return "day";
  return "unknown";
};

/** Newest remote listings across employers; the feed is not an employer inventory. */
export function createHimalayasConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "Himalayas",
    async search(_query, _cursor, signal) {
      const url = new URL("https://himalayas.app/jobs/api");
      // The API caps the response at 20 regardless of a higher limit.
      url.searchParams.set("limit", "20");
      const response = await fetchJson(url, { ...options, signal });
      const { jobs: items } = feed.parse(response.data);
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const item of items) {
        const parsed = rawJob.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(job.guid, job);
      return {
        canMarkRemovals: false,
        jobs: jobs.map((job) => ({
          externalId: job.guid,
          url: job.applicationLink || job.guid,
          company: job.companyName,
        })),
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const raw = cache.get(reference.externalId);
      if (!raw) throw new Error("Scan Himalayas before fetching a job.");
      return raw;
    },
    async normalize(raw) {
      const description = htmlToText(raw.description);
      const url = raw.applicationLink || raw.guid;
      const { salaryMin, salaryMax } = salaryRange(
        raw.minSalary,
        raw.maxSalary,
      );
      const input = jobInputSchema.parse({
        title: htmlToText(raw.title),
        company: htmlToText(raw.companyName),
        description,
        location: (raw.locationRestrictions ?? []).join(", ").slice(0, 200),
        country: "",
        industry: (raw.categories ?? []).slice(0, 3).join(", ").slice(0, 200),
        employmentType: employmentType(raw.employmentType ?? ""),
        seniority: "Unknown",
        workType: "Remote",
        salaryMin,
        salaryMax,
        salaryPeriod:
          salaryMin === null && salaryMax === null
            ? "unknown"
            : period(raw.salaryPeriod ?? ""),
        currency: ["CAD", "USD", "EUR", "GBP"].includes(raw.currency ?? "")
          ? raw.currency
          : "Unknown",
        jobUrl: url,
        // pubDate is Unix seconds, not an ISO timestamp.
        postedAt: raw.pubDate
          ? isoDate(new Date(raw.pubDate * 1000).toISOString())
          : null,
      });
      return {
        ...input,
        externalId: raw.guid,
        provider: "Himalayas" as const,
        sourceUrl: url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
