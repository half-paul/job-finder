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
  shortcode: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default(""),
  url: z.url(),
  employment_type: z.string().nullable().optional().default(""),
  telecommuting: z.boolean().nullable().optional(),
  function: z.string().nullable().optional().default(""),
  industry: z.string().nullable().optional().default(""),
  city: z.string().nullable().optional().default(""),
  state: z.string().nullable().optional().default(""),
  country: z.string().nullable().optional().default(""),
  published_on: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

const account = z.object({
  name: z.string().optional().default(""),
  jobs: z.array(z.unknown()).optional().default([]),
});

const accountUrl = (board: string) =>
  `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}`;

const employmentType = (value: string) => {
  const kind = value.toLowerCase();
  if (/contract|freelance/.test(kind)) return "Contract";
  if (/full[ -]?time/.test(kind)) return "Full-time";
  if (/part[ -]?time|intern|temporary/.test(kind)) return "Temporary";
  return "Unknown";
};

export function createWorkableConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  let accountName = "";
  return {
    name: "Workable",
    async search(query, previous, signal) {
      if (!query.board) throw new Error("Workable account name is required");
      const url = new URL(accountUrl(query.board));
      url.searchParams.set("details", "true");
      const headers: Record<string, string> = {};
      if (previous?.etag) headers["If-None-Match"] = previous.etag;
      if (previous?.lastModified)
        headers["If-Modified-Since"] = previous.lastModified;
      const response = await fetchJson(url, { ...options, signal }, headers);
      if (response.status === 304)
        return { jobs: [], complete: true, notModified: true };
      const data = account.parse(response.data);
      accountName = data.name;
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const item of data.jobs) {
        const parsed = rawJob.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(job.shortcode, job);
      return {
        jobs: jobs.map((job) => ({
          externalId: job.shortcode,
          url: job.url,
          board: query.board,
          company: data.name || query.company,
        })),
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
      // One request returns the whole board with descriptions, so a job that is
      // missing here was not in the board the scan just read.
      if (!cached)
        throw new Error("Scan the Workable account before fetching a job.");
      return cached;
    },
    async normalize(raw, context) {
      const description = htmlToText(raw.description);
      const location = [raw.city, raw.state, raw.country]
        .filter(Boolean)
        .join(", ");
      const input = jobInputSchema.parse({
        title: htmlToText(raw.title),
        company:
          htmlToText(accountName) ||
          context.query.company ||
          context.query.board,
        description,
        location: location.slice(0, 200),
        country: (raw.country ?? "").slice(0, 200),
        industry: (raw.industry || raw.function || "").slice(0, 200),
        employmentType: employmentType(raw.employment_type ?? ""),
        seniority: "Unknown",
        workType: raw.telecommuting
          ? "Remote"
          : location
            ? "On-site"
            : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.published_on ?? raw.created_at),
      });
      return {
        ...input,
        externalId: raw.shortcode,
        provider: "Workable" as const,
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
