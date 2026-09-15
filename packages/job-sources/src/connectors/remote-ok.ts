import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  isoDate,
  type ConnectorOptions,
  type JobReference,
  type SourceConnector,
} from "../index";

const rawJob = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string(),
  company: z.string(),
  position: z.string(),
  description: z.string(),
  location: z.string().optional().default(""),
  date: z.string().optional().nullable(),
  url: z.string().optional().default(""),
  apply_url: z.string().optional().default(""),
  salary_min: z.number().optional().nullable(),
  salary_max: z.number().optional().nullable(),
  tags: z.array(z.string()).optional().default([]),
});

const feed = z.array(z.unknown());

export function createRemoteOkConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "RemoteOK",
    async search(_query, _cursor, signal) {
      const response = await fetchJson(new URL("https://remoteok.com/api"), {
        ...options,
        signal,
      });
      const items = feed.parse(response.data);
      const jobs: JobReference[] = [];
      for (const item of items) {
        const parsed = rawJob.safeParse(item);
        if (!parsed.success) continue;
        const url = parsed.data.url || parsed.data.apply_url;
        if (!url) continue;
        cache.set(String(parsed.data.id), parsed.data);
        jobs.push({
          externalId: String(parsed.data.id),
          url,
          board: "remoteok",
          company: parsed.data.company,
        });
      }
      return {
        canMarkRemovals: false,
        jobs,
        next:
          response.etag || response.lastModified
            ? { etag: response.etag, lastModified: response.lastModified }
            : undefined,
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const cached = cache.get(reference.externalId);
      if (!cached)
        throw new Error(
          "Run a complete RemoteOK feed scan before fetching a job",
        );
      return cached;
    },
    async normalize(raw) {
      const description = htmlToText(raw.description);
      const url = raw.url || raw.apply_url;
      const input = jobInputSchema.parse({
        title: raw.position,
        company: raw.company,
        description,
        location: raw.location,
        country: "",
        industry: raw.tags.slice(0, 1).join(", "),
        employmentType: raw.tags.some((tag) => /part[- ]time/i.test(tag))
          ? "Temporary"
          : "Full-time",
        seniority: "Unknown",
        workType: "Remote",
        salaryMin: raw.salary_min && raw.salary_min > 0 ? raw.salary_min : null,
        salaryMax: raw.salary_max && raw.salary_max > 0 ? raw.salary_max : null,
        salaryPeriod: raw.salary_min || raw.salary_max ? "year" : "unknown",
        currency: "USD",
        jobUrl: url,
        postedAt: isoDate(raw.date),
      });
      return {
        ...input,
        externalId: String(raw.id),
        provider: "RemoteOK" as const,
        sourceUrl: url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
