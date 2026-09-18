import { z } from "zod";

export const httpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((v) => new URL(v).protocol === "https:", "Use an HTTPS URL");

/** One posting as the crawler saw it. Untrusted until the worker validates it. */
export const crawledJobSchema = z.object({
  title: z.string().trim().min(1).max(300),
  url: httpsUrl,
  id: z.string().trim().max(200).optional(),
  location: z.string().trim().max(300).default(""),
  description: z.string().max(50_000).default(""),
  postedAt: z.string().max(64).nullable().default(null),
});
export type CrawledJob = z.infer<typeof crawledJobSchema>;

export const crawlRequestSchema = z.object({
  url: httpsUrl,
  maxPages: z.number().int().min(1).max(20).default(20),
  maxJobs: z.number().int().min(1).max(500).default(500),
});
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;

export const crawlResponseSchema = z.object({
  jobs: z.array(crawledJobSchema).max(500),
  complete: z.boolean(),
  warnings: z.array(z.string().max(500)).max(50),
});
export type CrawlResponse = z.infer<typeof crawlResponseSchema>;

export const captureRequestSchema = z.object({ url: httpsUrl });

/** Request headers a saved pattern may replay. Cookies and auth never qualify. */
export const capturedHeaderAllowlist = [
  "accept",
  "content-type",
  "x-requested-with",
] as const;

export const capturedRequestSchema = z.object({
  url: httpsUrl,
  method: z.enum(["GET", "POST"]),
  headers: z.record(z.string(), z.string().max(500)),
  /** Raw request body text, or null for GET. */
  body: z.string().max(10_000).nullable(),
  /** JSON pointer to the postings array inside the response. */
  jobsPath: z.string().max(200),
  sample: z.array(z.record(z.string(), z.unknown())).min(1).max(3),
});
export type CapturedRequest = z.infer<typeof capturedRequestSchema>;

export const captureResponseSchema = z.object({
  patterns: z.array(capturedRequestSchema).max(10),
  warnings: z.array(z.string().max(500)).max(50),
});
export type CaptureResponse = z.infer<typeof captureResponseSchema>;

export const crawlerErrorKinds = [
  "blocked",
  "timeout",
  "navigation",
  "captcha",
  "internal",
] as const;
export const crawlerErrorSchema = z.object({
  error: z.string().max(1000),
  kind: z.enum(crawlerErrorKinds),
});
export type CrawlerError = z.infer<typeof crawlerErrorSchema>;

/** JSON pointers relative to one posting object. */
export const patternFieldMapSchema = z.object({
  title: z.string().max(200),
  url: z.string().max(200),
  id: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  description: z.string().max(200).optional(),
  postedAt: z.string().max(200).optional(),
});
export type PatternFieldMap = z.infer<typeof patternFieldMapSchema>;

/** A replayable request. `{page}` in the template or body is 1-based. */
export const crawlPatternSpecSchema = z.object({
  urlTemplate: z.string().url().max(2000),
  method: z.enum(["GET", "POST"]),
  headers: z.record(z.string(), z.string().max(500)),
  body: z.string().max(10_000).nullable(),
  jobsPath: z.string().max(200),
  fieldMap: patternFieldMapSchema,
});
export type CrawlPatternSpec = z.infer<typeof crawlPatternSpecSchema>;

/** Renders a template string by replacing `{page}` with the given number. */
export function renderTemplate(template: string, page: number): string {
  return template.replace(/\{page\}/g, String(page));
}

/** RFC 6901 lookup. Empty pointer returns the document. */
export function jsonPointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return undefined;
      current = current[index];
    } else if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
