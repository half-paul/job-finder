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
  id: z.union([z.string(), z.number()]),
  title: z.string().min(1),
  description: z.string(),
  redirect_url: z.url(),
  created: z.string().nullable().optional(),
  company: z
    .object({ display_name: z.string().nullable().optional().default("") })
    .nullable()
    .optional(),
  location: z
    .object({ display_name: z.string().nullable().optional().default("") })
    .nullable()
    .optional(),
  category: z
    .object({ label: z.string().nullable().optional().default("") })
    .nullable()
    .optional(),
  contract_time: z.string().nullable().optional().default(""),
  contract_type: z.string().nullable().optional().default(""),
  salary_min: z.number().nullable().optional(),
  salary_max: z.number().nullable().optional(),
  salary_is_predicted: z.union([z.string(), z.number()]).nullable().optional(),
});

const feed = z.object({ results: z.array(z.unknown()).optional().default([]) });

const pageSize = 50;
/** The feed is effectively unbounded; a scan reads the newest pages only. */
const maxPages = 10;

/** Adzuna prices in the currency of the country endpoint being queried. */
const currencies: Record<string, "USD" | "CAD" | "EUR" | "GBP"> = {
  us: "USD",
  ca: "CAD",
  gb: "GBP",
  de: "EUR",
  fr: "EUR",
  nl: "EUR",
  es: "EUR",
  it: "EUR",
  at: "EUR",
  be: "EUR",
};

export function createAdzunaConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  const country = (process.env.ADZUNA_COUNTRY ?? "us").trim().toLowerCase();
  return {
    name: "Adzuna",
    async search(query, cursor, signal) {
      const appId = process.env.ADZUNA_APP_ID;
      const appKey = process.env.ADZUNA_APP_KEY;
      if (!appId || !appKey)
        throw new Error(
          "Set ADZUNA_APP_ID and ADZUNA_APP_KEY before scanning Adzuna.",
        );
      if (!/^[a-z]{2}$/.test(country))
        throw new Error("ADZUNA_COUNTRY must be a two-letter country code.");
      const page = Math.max(1, Number(cursor?.cursor ?? 1) || 1);
      const url = new URL(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`,
      );
      url.searchParams.set("app_id", appId);
      url.searchParams.set("app_key", appKey);
      url.searchParams.set("results_per_page", String(pageSize));
      url.searchParams.set("content-type", "application/json");
      if (query.terms.length)
        url.searchParams.set("what", query.terms.join(" ").slice(0, 200));
      const response = await fetchJson(url, { ...options, signal });
      const data = feed.parse(response.data);
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const item of data.results) {
        const parsed = rawJob.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(String(job.id), job);
      const hasMore = data.results.length === pageSize && page < maxPages;
      return {
        canMarkRemovals: false,
        jobs: jobs.map((job) => ({
          externalId: String(job.id),
          url: job.redirect_url,
          company: job.company?.display_name ?? "",
        })),
        next: hasMore ? { cursor: String(page + 1) } : undefined,
        complete: !hasMore,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const raw = cache.get(reference.externalId);
      if (!raw) throw new Error("Scan Adzuna before fetching a job.");
      return raw;
    },
    async normalize(raw) {
      const description = htmlToText(raw.description);
      const company = raw.company?.display_name ?? "";
      if (!company) throw new Error("Adzuna listing has no employer name");
      const location = raw.location?.display_name ?? "";
      // Adzuna fills missing pay with a model estimate. A predicted figure is
      // not what the employer offered, so it is dropped rather than stored.
      const predicted =
        raw.salary_is_predicted !== null &&
        raw.salary_is_predicted !== undefined &&
        String(raw.salary_is_predicted) === "1";
      const { salaryMin, salaryMax } = predicted
        ? { salaryMin: null, salaryMax: null }
        : salaryRange(raw.salary_min, raw.salary_max);
      const kind = `${raw.contract_time ?? ""} ${raw.contract_type ?? ""}`;
      const input = jobInputSchema.parse({
        title: htmlToText(raw.title),
        company: htmlToText(company),
        description,
        location: location.slice(0, 200),
        country: "",
        industry: (raw.category?.label ?? "").slice(0, 200),
        employmentType: /contract|freelance/i.test(kind)
          ? "Contract"
          : /permanent/i.test(kind)
            ? "Permanent"
            : /full[ _-]?time/i.test(kind)
              ? "Full-time"
              : /part[ _-]?time/i.test(kind)
                ? "Temporary"
                : "Unknown",
        seniority: "Unknown",
        workType: /remote|work from home/i.test(`${raw.title} ${location}`)
          ? "Remote"
          : location
            ? "On-site"
            : "Unknown",
        salaryMin,
        salaryMax,
        salaryPeriod:
          salaryMin === null && salaryMax === null ? "unknown" : "year",
        currency: currencies[country] ?? "Unknown",
        jobUrl: raw.redirect_url,
        postedAt: isoDate(raw.created),
      });
      return {
        ...input,
        externalId: String(raw.id),
        provider: "Adzuna" as const,
        sourceUrl: raw.redirect_url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
