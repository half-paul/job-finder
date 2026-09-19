import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  jobInputSchema,
  maxSalary,
  type CrawlPatternSpec,
} from "@jobfinder/shared";
import {
  fetchText,
  retryAfterMs,
  SourceHttpError,
  type TransportOptions,
} from "./transport";
import {
  createHttpCrawlerClient,
  crawlerClientFromEnv,
  resolveCrawlerClient,
  type CrawlerClient,
} from "./crawler-client";
import { parseXml } from "./xml";

export * from "./transport";
export { parseXml, toArray, text } from "./xml";
export type { CrawlerClient } from "./crawler-client";

export type SourceProvider =
  | "Greenhouse"
  | "Lever"
  | "Ashby"
  | "Workable"
  | "Personio"
  | "SmartRecruiters"
  | "Rippling"
  | "RemoteOK"
  | "Jobicy"
  | "Remotive"
  | "TheMuse"
  | "Himalayas"
  | "WeWorkRemotely"
  | "USAJOBS"
  | "Adzuna"
  | "JSON-LD"
  | "Careers"
  | "CapturedApi"
  | "Browser";

export interface SearchQuery {
  board: string;
  terms: string[];
  company?: string;
  sourceUrl?: string;
}

export interface SearchCursor {
  cursor?: string;
  etag?: string;
  lastModified?: string;
}

export interface JobReference {
  externalId: string;
  url: string;
  board?: string;
  company?: string;
  sourceUrl?: string;
  etag?: string;
}

export interface DiscoveredPage {
  canMarkRemovals?: boolean;
  jobs: JobReference[];
  next?: SearchCursor;
  complete: boolean;
  notModified: boolean;
}

export type NormalizedJob = z.infer<typeof jobInputSchema> & {
  externalId: string;
  provider: SourceProvider;
  sourceUrl: string;
  descriptionHash: string;
};

export interface NormalizeContext {
  query: SearchQuery;
}

/** Provider implementations must validate unknown payloads before normalization. */
export interface SourceConnector<RawJob = unknown> {
  name: SourceProvider;
  search(
    query: SearchQuery,
    cursor?: SearchCursor,
    signal?: AbortSignal,
  ): Promise<DiscoveredPage>;
  fetchJob(reference: JobReference, signal?: AbortSignal): Promise<RawJob>;
  normalize(raw: RawJob, context: NormalizeContext): Promise<NormalizedJob>;
}

export interface ConnectorOptions extends TransportOptions {
  jsonLdAllowedHosts?: string[];
  crawlerClient?: CrawlerClient | null;
  /** The saved request a `CapturedApi` source replays. Null means unresolved. */
  crawlPattern?: CrawlPatternSpec | null;
}

export const descriptionDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const entities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/**
 * Removes `<name>...</name>` elements, lazily and blind to nesting — exactly
 * what `/<name\b[\s\S]*?<\/name>/gi` matched, but in one forward pass.
 *
 * The regex form is quadratic on untrusted input: given `"<script"` repeated
 * with no closing tag, every one of the ~n/7 opening positions expands
 * `[\s\S]*?` to the end of the string before failing. Measured at 200 KB:
 * 2.86 s, rising as n². `htmlToText` is on the crawler's hostile-input path
 * (`apps/crawler/src/extract.ts` hands it a description container taken
 * straight off an unvetted careers page), and the crawler is a single-
 * threaded process serving `/health` from the same event loop.
 *
 * Both `indexOf` cursors only move right, so the total work is linear. A
 * missing close tag ends the scan rather than advancing one character and
 * looking again: if there is no `</script>` after this point there is none
 * after any later point either.
 */
function stripElement(value: string, name: string): string {
  const lower = value.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}>`;
  const parts: string[] = [];
  let copied = 0;
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start < 0) break;
    // `\b` in the old pattern: `<scriptable>` is not a `<script>`.
    const after = lower.charCodeAt(start + open.length);
    if (
      (after >= 97 && after <= 122) ||
      (after >= 48 && after <= 57) ||
      after === 45
    ) {
      pos = start + open.length;
      continue;
    }
    const end = lower.indexOf(close, start + open.length);
    if (end < 0) break;
    parts.push(value.slice(copied, start), " ");
    copied = end + close.length;
    pos = copied;
  }
  if (copied === 0) return value;
  parts.push(value.slice(copied));
  return parts.join("");
}

export function htmlToText(value: string): string {
  return (
    stripElement(stripElement(value, "script"), "style")
      .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // `[^<>]+`, not `[^>]+`: on a run of `<` with no `>` the old class
      // consumed to the end of the string from every one of the n positions
      // and backtracked the whole way (200 KB → 14.69 s, n²), whereas this one
      // fails after a single character compare. A tag cannot contain a raw `<`
      // in valid markup, so well-formed input is stripped identically.
      .replace(/<[^<>]+>/g, " ")
      .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
        if (/^#x/i.test(code))
          return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
        if (code.startsWith("#"))
          return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
        return entities[code.toLowerCase()] ?? match;
      })
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .trim()
  );
}

export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Feed salaries arrive as floats, formatted strings and free text. Only a clean
 * magnitude inside the schema bounds is kept; anything with a range separator,
 * a suffix or stray punctuation becomes null instead of a fabricated number.
 */
export function salaryInt(value: unknown): number | null {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0 || raw > maxSalary) return null;
  return Math.round(raw);
}

/** Keeps the pair ordered so a reversed feed range never fails schema validation. */
export function salaryRange(
  min: unknown,
  max: unknown,
): { salaryMin: number | null; salaryMax: number | null } {
  const low = salaryInt(min);
  const high = salaryInt(max);
  if (low !== null && high !== null && low > high)
    return { salaryMin: high, salaryMax: low };
  return { salaryMin: low, salaryMax: high };
}

export async function fetchJson(
  url: URL,
  options: TransportOptions,
  headers: Record<string, string> = {},
): Promise<{
  data: unknown;
  status: number;
  etag?: string;
  lastModified?: string;
}> {
  const { response, text } = await fetchText(url, headers, options);
  const metadata = {
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  };
  if (response.status === 304) return { data: null, status: 304, ...metadata };
  if (!response.ok)
    throw new SourceHttpError(
      response.status,
      retryAfterMs(response.headers.get("retry-after")),
    );
  try {
    return { data: JSON.parse(text), status: response.status, ...metadata };
  } catch {
    throw new Error(`Source returned invalid JSON from ${url.hostname}`);
  }
}

export async function fetchXml(
  url: URL,
  options: TransportOptions,
  headers: Record<string, string> = {},
): Promise<{
  data: unknown;
  status: number;
  etag?: string;
  lastModified?: string;
}> {
  const { response, text } = await fetchText(url, headers, options);
  const metadata = {
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  };
  if (response.status === 304) return { data: null, status: 304, ...metadata };
  if (!response.ok)
    throw new SourceHttpError(
      response.status,
      retryAfterMs(response.headers.get("retry-after")),
    );
  try {
    return { data: parseXml(text), status: response.status, ...metadata };
  } catch {
    throw new Error(`Source returned invalid XML from ${url.hostname}`);
  }
}

export function providerName(value: string): SourceProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "greenhouse") return "Greenhouse";
  if (normalized === "lever") return "Lever";
  if (normalized === "ashby") return "Ashby";
  if (normalized === "remoteok" || normalized === "remote-ok")
    return "RemoteOK";
  if (normalized === "workable") return "Workable";
  if (normalized === "personio") return "Personio";
  if (normalized === "smartrecruiters" || normalized === "smart-recruiters")
    return "SmartRecruiters";
  if (normalized === "rippling") return "Rippling";
  if (normalized === "remotive") return "Remotive";
  if (normalized === "themuse" || normalized === "the-muse") return "TheMuse";
  if (normalized === "himalayas") return "Himalayas";
  if (
    normalized === "weworkremotely" ||
    normalized === "we-work-remotely" ||
    normalized === "wwr"
  )
    return "WeWorkRemotely";
  if (normalized === "usajobs" || normalized === "usa-jobs") return "USAJOBS";
  if (normalized === "adzuna") return "Adzuna";
  if (normalized === "json-ld" || normalized === "jsonld") return "JSON-LD";
  if (normalized === "jobicy") return "Jobicy";
  if (normalized === "careers") return "Careers";
  if (normalized === "capturedapi" || normalized === "captured-api")
    return "CapturedApi";
  if (normalized === "browser") return "Browser";
  throw new Error("Unsupported source provider");
}

export function createConnector(
  provider: SourceProvider,
  options: ConnectorOptions = {},
): SourceConnector {
  switch (provider) {
    case "Greenhouse":
      return createGreenhouseConnector(options);
    case "Lever":
      return createLeverConnector(options);
    case "Ashby":
      return createAshbyConnector(options);
    case "Workable":
      return createWorkableConnector(options);
    case "Personio":
      return createPersonioConnector(options);
    case "SmartRecruiters":
      return createSmartRecruitersConnector(options);
    case "Rippling":
      return createRipplingConnector(options);
    case "Remotive":
      return createRemotiveConnector(options);
    case "TheMuse":
      return createTheMuseConnector(options);
    case "Himalayas":
      return createHimalayasConnector(options);
    case "WeWorkRemotely":
      return createWeWorkRemotelyConnector(options);
    case "USAJOBS":
      return createUsaJobsConnector(options);
    case "Adzuna":
      return createAdzunaConnector(options);
    case "RemoteOK":
      return createRemoteOkConnector(options);
    case "JSON-LD":
      return createJsonLdConnector(options);
    case "Jobicy":
      return createJobicyConnector(options);
    case "Careers":
      // Careers sources are scanned through the adaptive connector in
      // @jobfinder/discovery, which enforces robots on every hop. There is
      // deliberately no plain-fetch Careers connector to fall back to.
      throw new Error(
        "Careers sources are scanned through the discovery package, not createConnector.",
      );
    case "CapturedApi":
      return createCapturedApiConnector(options);
    case "Browser":
      return createBrowserConnector(options);
  }
}

import {
  createAdzunaConnector,
  createAshbyConnector,
  createBrowserConnector,
  createCapturedApiConnector,
  capturedApiMaxJobs,
  createGreenhouseConnector,
  createHimalayasConnector,
  createJsonLdConnector,
  createLeverConnector,
  createPersonioConnector,
  personioBoardHost,
  createRemoteOkConnector,
  createRemotiveConnector,
  createRipplingConnector,
  createSmartRecruitersConnector,
  createTheMuseConnector,
  createUsaJobsConnector,
  createWeWorkRemotelyConnector,
  createWorkableConnector,
  createJobicyConnector,
} from "./connectors";

export {
  createAdzunaConnector,
  createAshbyConnector,
  createBrowserConnector,
  createCapturedApiConnector,
  capturedApiMaxJobs,
  createGreenhouseConnector,
  createHimalayasConnector,
  createJsonLdConnector,
  createLeverConnector,
  createPersonioConnector,
  personioBoardHost,
  createRemoteOkConnector,
  createRemotiveConnector,
  createRipplingConnector,
  createSmartRecruitersConnector,
  createTheMuseConnector,
  createUsaJobsConnector,
  createWeWorkRemotelyConnector,
  createWorkableConnector,
  createJobicyConnector,
  createHttpCrawlerClient,
  crawlerClientFromEnv,
  resolveCrawlerClient,
};
export {
  extractJsonLdJobs,
  jsonLdExternalId,
  normalizeJsonLdJob,
  jsonLdJobSchema,
  type JsonLdJob,
} from "./connectors/json-ld";
