import {
  capturedHeaderAllowlist,
  jsonPointerGet,
  type CapturedRequest,
  type CrawlPatternSpec,
  type PatternFieldMap,
} from "@jobfinder/shared";
import { fetchJson, type TransportOptions } from "@jobfinder/job-sources";

const fieldPatterns: {
  field: keyof PatternFieldMap;
  keys: RegExp;
  nested?: RegExp;
}[] = [
  {
    field: "title",
    keys: /^(title|jobTitle|name|position|positionName|role)$/i,
  },
  {
    field: "url",
    keys: /^(url|absolute_url|absoluteUrl|applyUrl|apply_url|link|href|jobUrl|hostedUrl)$/i,
  },
  { field: "id", keys: /^(id|jobId|job_id|requisitionId|reqId|slug)$/i },
  {
    field: "location",
    keys: /^(location|locationName|location_name|city|office)$/i,
    nested: /^(name|city|label|text)$/i,
  },
  {
    field: "description",
    keys: /^(description|content|body|descriptionHtml|jobDescription)$/i,
  },
  {
    field: "postedAt",
    keys: /^(postedAt|posted_at|datePosted|createdAt|created_at|updatedAt|updated_at|publishedAt)$/i,
  },
];

const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Picks pointers from the first sample's keys. Title and URL are mandatory. */
export function inferFieldMap(
  sample: Record<string, unknown>[],
): PatternFieldMap | null {
  const first = sample[0];
  if (!first) return null;
  const map: Partial<PatternFieldMap> = {};
  for (const { field, keys, nested } of fieldPatterns) {
    for (const [key, value] of Object.entries(first)) {
      if (!keys.test(key)) continue;
      if (typeof value === "string" || typeof value === "number") {
        map[field] = `/${escapePointer(key)}`;
        break;
      }
      if (
        nested &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const inner = Object.keys(value).find((k) => nested.test(k));
        if (inner) {
          map[field] = `/${escapePointer(key)}/${escapePointer(inner)}`;
          break;
        }
      }
    }
  }
  if (!map.title || !map.url) return null;
  return map as PatternFieldMap;
}

const pageParam = /^(page|pageNumber|page_number|pageIndex|p)$/i;

/** Rewrites the first numeric page parameter into a `{page}` placeholder. */
export function buildPatternSpec(
  captured: CapturedRequest,
): CrawlPatternSpec | null {
  const { url, method, headers, body, jobsPath, sample } = captured;
  if (!sample.length) return null;
  const fieldMap = inferFieldMap(sample);
  if (!fieldMap) return null;
  let urlTemplate = url;
  let bodyStr = body ?? null;
  const urlObj = new URL(url);
  const hasPageParam = pageParam.test(
    urlObj.searchParams.keys().next().value ?? "",
  );
  if (hasPageParam) {
    urlObj.searchParams.forEach((value, key) => {
      if (pageParam.test(key)) {
        urlObj.searchParams.set(key, "{page}");
      }
    });
    urlTemplate = urlObj.toString();
  } else if (bodyStr) {
    const bodyObj = JSON.parse(bodyStr);
    if (typeof bodyObj === "object" && bodyObj !== null) {
      const keys = Object.keys(bodyObj);
      for (const key of keys) {
        if (pageParam.test(key)) {
          bodyObj[key] = "{page}";
          bodyStr = JSON.stringify(bodyObj);
          break;
        }
      }
    }
  }
  const headersObj: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      capturedHeaderAllowlist.some((allowed) => allowed === key.toLowerCase())
    ) {
      headersObj[key] = value;
    }
  }
  return {
    urlTemplate,
    method: method as "GET" | "POST",
    headers: headersObj,
    body: bodyStr,
    jobsPath,
    fieldMap,
  };
}

/** Validates a pattern by replaying it and counting postings. */
export async function validatePattern(
  spec: CrawlPatternSpec,
  options: TransportOptions,
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  const { urlTemplate, method, headers, body, jobsPath, fieldMap } = spec;
  const url = new URL(urlTemplate.replace("{page}", "1"));
  const { data, status } = await fetchJson(
    url,
    {
      ...options,
      method,
      body: body ?? undefined,
    },
    headers,
  );
  if (status !== 200) return { ok: false, reason: `HTTP ${status}` };
  const postings = jsonPointerGet(data, jobsPath);
  if (!Array.isArray(postings)) {
    return { ok: false, reason: "No postings at jobsPath" };
  }
  if (postings.length === 0) {
    return { ok: false, reason: "Replay returned no postings" };
  }
  // Try to map the first posting to ensure fieldMap works
  const first = postings[0];
  for (const [field, pointer] of Object.entries(fieldMap)) {
    const value = jsonPointerGet(first, pointer);
    if (value === undefined) {
      return { ok: false, reason: `Cannot resolve field ${field}` };
    }
  }
  return { ok: true, count: postings.length };
}

/** Renders a template string by replacing `{page}` with the given number. */
export function renderTemplate(template: string, page: number): string {
  return template.replace(/{page}/g, String(page));
}
