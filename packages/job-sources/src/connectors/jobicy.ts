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
  id: z.union([z.string(), z.number()]),
  url: z.url(),
  jobTitle: z.string(),
  companyName: z.string(),
  jobDescription: z.string(),
  jobGeo: z.string().nullable().optional().default(""),
  jobIndustry: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional()
    .transform((value) =>
      Array.isArray(value) ? value : value ? [value] : [],
    ),
  jobType: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional()
    .transform((value) =>
      Array.isArray(value) ? value : value ? [value] : [],
    ),
  pubDate: z.string().nullable().optional(),
  salaryMin: z.coerce.number().nullable().optional(),
  salaryMax: z.coerce.number().nullable().optional(),
  salaryCurrency: z.string().nullable().optional(),
  salaryPeriod: z.string().nullable().optional(),
});

/** Latest listings across employers, not an exhaustive inventory for removals. */
export function createJobicyConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "Jobicy",
    async search(_query, _cursor, signal) {
      const response = await fetchJson(
        new URL("https://jobicy.com/api/v2/remote-jobs?count=200"),
        { ...options, signal },
      );
      const { jobs: items } = z
        .object({ jobs: z.array(z.unknown()) })
        .parse(response.data);
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const item of items) {
        const parsed = rawJob.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(String(job.id), job);
      return {
        jobs: jobs.map((job) => ({
          externalId: String(job.id),
          url: job.url,
          company: job.companyName,
        })),
        complete: true,
        notModified: false,
        canMarkRemovals: false,
      };
    },
    async fetchJob(reference) {
      const raw = cache.get(reference.externalId);
      if (!raw) throw new Error("Scan Jobicy before fetching a job.");
      return raw;
    },
    async normalize(raw) {
      const description = htmlToText(raw.jobDescription);
      const kind = raw.jobType.join(" ").toLowerCase();
      const period = raw.salaryPeriod?.toLowerCase() ?? "";
      const input = jobInputSchema.parse({
        title: htmlToText(raw.jobTitle),
        company: htmlToText(raw.companyName),
        description,
        location: raw.jobGeo,
        country: "",
        industry: raw.jobIndustry.join(", ").slice(0, 200),
        employmentType: /contract|freelance/.test(kind)
          ? "Contract"
          : /full/.test(kind)
            ? "Full-time"
            : "Unknown",
        workType: "Remote",
        seniority: "Unknown",
        salaryMin: raw.salaryMin ?? null,
        salaryMax: raw.salaryMax ?? null,
        salaryPeriod: /year|annual/.test(period)
          ? "year"
          : /hour/.test(period)
            ? "hour"
            : /month/.test(period)
              ? "month"
              : "unknown",
        currency: ["CAD", "USD", "EUR", "GBP"].includes(
          raw.salaryCurrency ?? "",
        )
          ? raw.salaryCurrency
          : "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.pubDate),
      });
      return {
        ...input,
        externalId: String(raw.id),
        provider: "Jobicy",
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
