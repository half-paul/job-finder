import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  assertHttpsUrl,
  descriptionDigest,
  fetchText,
  htmlToText,
  isoDate,
  retryAfterMs,
  SourceHttpError,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const rawJob = z.object({
  "@type": z.literal("JobPosting"),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  identifier: z.union([z.string(), z.number()]).nullable().optional(),
  datePosted: z.string().optional().nullable(),
  employmentType: z.string().optional().default(""),
  hiringOrganization: z.object({ name: z.string().optional() }).optional(),
  jobLocation: z
    .object({
      address: z
        .object({
          addressLocality: z.string().optional(),
          addressRegion: z.string().optional(),
          addressCountry: z.string().optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});

type JsonLdJob = z.infer<typeof rawJob>;

function extractJobs(html: string): JsonLdJob[] {
  const jobs: JsonLdJob[] = [];
  const scripts =
    html.match(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ) ?? [];
  for (const script of scripts) {
    const match = script.match(/>([\s\S]*)<\/script>/i);
    if (!match) continue;
    try {
      const parsed: unknown = JSON.parse(match[1]);
      const nodes = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            "@graph" in parsed &&
            Array.isArray((parsed as { "@graph": unknown[] })["@graph"])
          ? (parsed as { "@graph": unknown[] })["@graph"]
          : [parsed];
      for (const node of nodes) {
        const job = rawJob.safeParse(node);
        if (job.success) jobs.push(job.data);
      }
    } catch {
      // A page can contain an invalid JSON-LD block alongside a valid one.
    }
  }
  return jobs;
}

export function createJsonLdConnector(
  options: ConnectorOptions = {},
): SourceConnector<JsonLdJob> {
  const cache = new Map<string, JsonLdJob>();
  return {
    name: "JSON-LD",
    async search(query, cursor, signal) {
      if (!query.sourceUrl) throw new Error("A JSON-LD source URL is required");
      const url = new URL(query.sourceUrl);
      const allowed = (options.jsonLdAllowedHosts ?? []).map((host) =>
        host.toLowerCase().replace(/^\*\./, ""),
      );
      if (
        !allowed.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      )
        throw new Error("JSON-LD host is not allowlisted");
      assertHttpsUrl(url);
      const headers: Record<string, string> = {};
      if (cursor?.etag) headers["If-None-Match"] = cursor.etag;
      if (cursor?.lastModified)
        headers["If-Modified-Since"] = cursor.lastModified;
      const { response, text } = await fetchText(url, headers, {
        ...options,
        signal,
      });
      if (response.status === 304)
        return { jobs: [], complete: true, notModified: true };
      if (!response.ok)
        throw new SourceHttpError(
          response.status,
          retryAfterMs(response.headers.get("retry-after")),
        );
      const jobs = extractJobs(text);
      return {
        jobs: jobs.map((job) => {
          const externalId = job.identifier ? String(job.identifier) : job.url;
          cache.set(externalId, job);
          return {
            externalId,
            url: job.url,
            sourceUrl: query.sourceUrl,
            company: query.company,
          };
        }),
        next:
          response.headers.get("etag") || response.headers.get("last-modified")
            ? {
                etag: response.headers.get("etag") ?? undefined,
                lastModified:
                  response.headers.get("last-modified") ?? undefined,
              }
            : undefined,
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      if (!reference.sourceUrl)
        throw new Error("A JSON-LD source URL is required");
      const cached = cache.get(reference.externalId);
      if (cached) return cached;
      const url = new URL(reference.sourceUrl);
      assertHttpsUrl(url);
      const { response, text } = await fetchText(
        url,
        {},
        { ...options, signal },
      );
      if (!response.ok)
        throw new SourceHttpError(
          response.status,
          retryAfterMs(response.headers.get("retry-after")),
        );
      const job = extractJobs(text).find(
        (candidate) =>
          String(candidate.identifier ?? "") === reference.externalId ||
          candidate.url === reference.externalId,
      );
      if (!job) throw new Error("JSON-LD job is no longer present");
      return job;
    },
    async normalize(raw, context) {
      const description = htmlToText(raw.description);
      const address = raw.jobLocation?.address;
      const location = [address?.addressLocality, address?.addressRegion]
        .filter(Boolean)
        .join(", ");
      const input = jobInputSchema.parse({
        title: raw.title,
        company:
          raw.hiringOrganization?.name ||
          context.query.company ||
          context.query.board,
        description,
        location,
        country: address?.addressCountry ?? "",
        industry: "",
        employmentType: /contract/i.test(raw.employmentType)
          ? "Contract"
          : /part/i.test(raw.employmentType)
            ? "Temporary"
            : /full/i.test(raw.employmentType)
              ? "Full-time"
              : "Unknown",
        seniority: "Unknown",
        workType: /remote/i.test(`${raw.title} ${description}`)
          ? "Remote"
          : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.datePosted),
      });
      return {
        ...input,
        externalId: raw.identifier ? String(raw.identifier) : raw.url,
        provider: "JSON-LD" as const,
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
