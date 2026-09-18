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
  name: z.string(),
  contents: z.string(),
  publication_date: z.string().nullable().optional(),
  locations: z
    .array(z.object({ name: z.string().optional().default("") }))
    .nullable()
    .optional()
    .default([]),
  categories: z
    .array(z.object({ name: z.string().optional().default("") }))
    .nullable()
    .optional()
    .default([]),
  refs: z.object({ landing_page: z.url() }),
  company: z.object({ name: z.string().optional().default("") }),
});

const feed = z.object({
  page_count: z.coerce.number().optional().default(1),
  results: z.array(z.unknown()),
});

/**
 * The public feed is roughly 400,000 listings deep. A scan walks the newest few
 * pages instead of the whole archive, so it can never prove an inventory.
 */
const maxPages = 5;

export function createTheMuseConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "TheMuse",
    async search(_query, cursor, signal) {
      const page = Math.max(1, Number(cursor?.cursor ?? 1) || 1);
      const url = new URL("https://www.themuse.com/api/public/jobs");
      url.searchParams.set("page", String(page));
      url.searchParams.set("descending", "true");
      const response = await fetchJson(url, { ...options, signal });
      const data = feed.parse(response.data);
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const item of data.results) {
        const parsed = rawJob.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(String(job.id), job);
      const last = Math.min(data.page_count, maxPages);
      const hasMore = page < last && jobs.length > 0;
      return {
        canMarkRemovals: false,
        jobs: jobs.map((job) => ({
          externalId: String(job.id),
          url: job.refs.landing_page,
          company: job.company.name,
        })),
        next: hasMore ? { cursor: String(page + 1) } : undefined,
        complete: !hasMore,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const raw = cache.get(reference.externalId);
      if (!raw) throw new Error("Scan The Muse before fetching a job.");
      return raw;
    },
    async normalize(raw) {
      const description = htmlToText(raw.contents);
      const location = (raw.locations ?? [])
        .map((entry) => entry.name)
        .filter(Boolean)
        .join("; ");
      const company = htmlToText(raw.company.name);
      if (!company) throw new Error("The Muse listing has no employer name");
      const input = jobInputSchema.parse({
        title: htmlToText(raw.name),
        company,
        description,
        location: location.slice(0, 200),
        country: "",
        industry: (raw.categories ?? [])
          .map((entry) => entry.name)
          .filter(Boolean)
          .join(", ")
          .slice(0, 200),
        employmentType: "Unknown",
        seniority: "Unknown",
        workType: /remote|flexible/i.test(location)
          ? "Remote"
          : location
            ? "On-site"
            : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.refs.landing_page,
        postedAt: isoDate(raw.publication_date),
      });
      return {
        ...input,
        externalId: String(raw.id),
        provider: "TheMuse" as const,
        sourceUrl: raw.refs.landing_page,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
