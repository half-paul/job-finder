import { createHash } from "node:crypto";
import type { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  fetchText,
  retryAfterMs,
  SourceHttpError,
  type TransportOptions,
} from "./transport";

export * from "./transport";

export type SourceProvider =
  | "Greenhouse"
  | "Lever"
  | "Ashby"
  | "RemoteOK"
  | "Jobicy"
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

export function htmlToText(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (/^#x/i.test(code))
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith("#"))
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      return entities[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

export function providerName(value: string): SourceProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "greenhouse") return "Greenhouse";
  if (normalized === "lever") return "Lever";
  if (normalized === "ashby") return "Ashby";
  if (normalized === "remoteok" || normalized === "remote-ok")
    return "RemoteOK";
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
    case "RemoteOK":
      return createRemoteOkConnector(options);
    case "JSON-LD":
      return createJsonLdConnector(options);
    case "Jobicy":
      return createJobicyConnector(options);
    case "Careers":
      return createCareersConnector(options);
    case "CapturedApi":
      throw new Error("Not implemented");
    case "Browser":
      throw new Error("Not implemented");
  }
}

import {
  createAshbyConnector,
  createCareersConnector,
  createGreenhouseConnector,
  createJsonLdConnector,
  createLeverConnector,
  createRemoteOkConnector,
  createJobicyConnector,
} from "./connectors";

export {
  createAshbyConnector,
  createCareersConnector,
  createGreenhouseConnector,
  createJsonLdConnector,
  createLeverConnector,
  createRemoteOkConnector,
  createJobicyConnector,
};
export * from "./posting-links";
export {
  extractJsonLdJobs,
  jsonLdExternalId,
  normalizeJsonLdJob,
  jsonLdJobSchema,
  type JsonLdJob,
} from "./connectors/json-ld";
