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
  title: z.string(),
  company_name: z.string(),
  description: z.string(),
  category: z.string().nullable().optional().default(""),
  job_type: z.string().nullable().optional().default(""),
  publication_date: z.string().nullable().optional(),
  candidate_required_location: z.string().nullable().optional().default(""),
});

const employmentType = (value: string) => {
  const kind = value.toLowerCase();
  if (/contract|freelance/.test(kind)) return "Contract";
  if (/full[_ -]?time/.test(kind)) return "Full-time";
  if (/part[_ -]?time|internship|temporary/.test(kind)) return "Temporary";
  return "Unknown";
};

/** Latest remote listings across employers, not an exhaustive inventory for removals. */
export function createRemotiveConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "Remotive",
    async search(_query, _cursor, signal) {
      // The endpoint ignores `limit` and returns a fixed newest-first slice
      // (16 listings when sampled), so a scan reads whatever it serves.
      const url = new URL("https://remotive.com/api/remote-jobs");
      const response = await fetchJson(url, { ...options, signal });
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
        canMarkRemovals: false,
        jobs: jobs.map((job) => ({
          externalId: String(job.id),
          url: job.url,
          company: job.company_name,
        })),
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const raw = cache.get(reference.externalId);
      if (!raw) throw new Error("Scan Remotive before fetching a job.");
      return raw;
    },
    async normalize(raw) {
      const description = htmlToText(raw.description);
      const input = jobInputSchema.parse({
        title: htmlToText(raw.title),
        company: htmlToText(raw.company_name),
        description,
        location: (raw.candidate_required_location ?? "").slice(0, 200),
        country: "",
        industry: (raw.category ?? "").slice(0, 200),
        employmentType: employmentType(raw.job_type ?? ""),
        seniority: "Unknown",
        workType: "Remote",
        // The feed's salary field is free text ("$50-60/hr", "85k"); a parsed
        // magnitude would be a guess, so the evaluator sees no salary at all.
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.publication_date),
      });
      return {
        ...input,
        externalId: String(raw.id),
        provider: "Remotive" as const,
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
