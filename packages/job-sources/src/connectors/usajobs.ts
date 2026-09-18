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

const named = z
  .array(z.object({ Name: z.string().optional().default("") }))
  .nullable()
  .optional()
  .default([]);

const descriptor = z.object({
  PositionTitle: z.string().min(1),
  PositionURI: z.url(),
  PositionLocationDisplay: z.string().nullable().optional().default(""),
  OrganizationName: z.string().nullable().optional().default(""),
  DepartmentName: z.string().nullable().optional().default(""),
  JobCategory: named,
  PositionSchedule: named,
  QualificationSummary: z.string().nullable().optional().default(""),
  PositionRemuneration: z
    .array(
      z.object({
        MinimumRange: z.union([z.string(), z.number()]).nullable().optional(),
        MaximumRange: z.union([z.string(), z.number()]).nullable().optional(),
        RateIntervalCode: z.string().nullable().optional().default(""),
      }),
    )
    .nullable()
    .optional()
    .default([]),
  PublicationStartDate: z.string().nullable().optional(),
  UserArea: z
    .object({
      Details: z
        .object({
          JobSummary: z.string().nullable().optional().default(""),
          MajorDuties: z.array(z.string()).nullable().optional().default([]),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const rawJob = z.object({
  MatchedObjectId: z.string().min(1),
  MatchedObjectDescriptor: descriptor,
});

const feed = z.object({
  SearchResult: z.object({
    SearchResultItems: z.array(z.unknown()).optional().default([]),
  }),
});

const pageSize = 100;
/** The search API is effectively unbounded; a scan reads the newest pages only. */
const maxPages = 10;

/** USAJOBS reports pay intervals as codes, not words. */
const period = (code: string) => {
  switch (code.trim().toUpperCase()) {
    case "PA":
      return "year";
    case "PH":
      return "hour";
    case "PM":
      return "month";
    case "PW":
      return "week";
    case "PD":
      return "day";
    default:
      return "unknown";
  }
};

export function createUsaJobsConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "USAJOBS",
    async search(query, cursor, signal) {
      const key = process.env.USAJOBS_API_KEY;
      const email = process.env.USAJOBS_EMAIL;
      if (!key || !email)
        throw new Error(
          "Set USAJOBS_API_KEY and USAJOBS_EMAIL before scanning USAJOBS.",
        );
      const page = Math.max(1, Number(cursor?.cursor ?? 1) || 1);
      const url = new URL("https://data.usajobs.gov/api/search");
      if (query.terms.length)
        url.searchParams.set("Keyword", query.terms.join(" ").slice(0, 200));
      url.searchParams.set("ResultsPerPage", String(pageSize));
      url.searchParams.set("Page", String(page));
      const response = await fetchJson(
        url,
        { ...options, signal },
        {
          // The API authenticates on a registered address in the agent string.
          "User-Agent": email,
          "Authorization-Key": key,
        },
      );
      const data = feed.parse(response.data);
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const item of data.SearchResult.SearchResultItems) {
        const parsed = rawJob.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(job.MatchedObjectId, job);
      const hasMore =
        data.SearchResult.SearchResultItems.length === pageSize &&
        page < maxPages;
      return {
        canMarkRemovals: false,
        jobs: jobs.map((job) => ({
          externalId: job.MatchedObjectId,
          url: job.MatchedObjectDescriptor.PositionURI,
          company: job.MatchedObjectDescriptor.OrganizationName ?? "",
        })),
        next: hasMore ? { cursor: String(page + 1) } : undefined,
        complete: !hasMore,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const raw = cache.get(reference.externalId);
      if (!raw) throw new Error("Scan USAJOBS before fetching a job.");
      return raw;
    },
    async normalize(raw) {
      const job = raw.MatchedObjectDescriptor;
      const details = job.UserArea?.Details;
      const description = htmlToText(
        [
          details?.JobSummary,
          (details?.MajorDuties ?? []).join("\n"),
          job.QualificationSummary,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      const pay = (job.PositionRemuneration ?? [])[0];
      const { salaryMin, salaryMax } = salaryRange(
        pay?.MinimumRange,
        pay?.MaximumRange,
      );
      const schedule = (job.PositionSchedule ?? [])
        .map((entry) => entry.Name)
        .join(" ");
      const location = job.PositionLocationDisplay ?? "";
      const input = jobInputSchema.parse({
        title: htmlToText(job.PositionTitle),
        company: job.OrganizationName || job.DepartmentName || "USAJOBS",
        description,
        location: location.slice(0, 200),
        country: "United States",
        industry: (job.JobCategory ?? [])
          .map((entry) => entry.Name)
          .filter(Boolean)
          .join(", ")
          .slice(0, 200),
        employmentType: /part[ -]?time|intern|temporary/i.test(schedule)
          ? "Temporary"
          : /full[ -]?time/i.test(schedule)
            ? "Full-time"
            : "Unknown",
        seniority: "Unknown",
        workType: /remote|telework/i.test(location) ? "Remote" : "On-site",
        salaryMin,
        salaryMax,
        salaryPeriod:
          salaryMin === null && salaryMax === null
            ? "unknown"
            : period(pay?.RateIntervalCode ?? ""),
        currency: "USD",
        jobUrl: job.PositionURI,
        postedAt: isoDate(job.PublicationStartDate),
      });
      return {
        ...input,
        externalId: raw.MatchedObjectId,
        provider: "USAJOBS" as const,
        sourceUrl: job.PositionURI,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
