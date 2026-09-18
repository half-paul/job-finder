import {
  capturedHeaderAllowlist,
  captureResponseSchema,
  jsonPointerGet,
  type CaptureResponse,
} from "@jobfinder/shared";
import { withSession } from "./session";

const titleKey = /title|name|position/i;
const urlKey = /url|link|href|permalink/i;

const looksLikePosting = (entry: unknown): boolean => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const hasTitle = Object.entries(record).some(
    ([key, value]) =>
      titleKey.test(key) && typeof value === "string" && !!value.trim(),
  );
  const hasUrl = Object.entries(record).some(
    ([key, value]) =>
      urlKey.test(key) && typeof value === "string" && !!value.trim(),
  );
  return hasTitle && hasUrl;
};

/**
 * The JSON pointer to the first array of two or more posting-shaped objects.
 * Two is the floor because a one-element array is as likely to be a banner or
 * a featured role as a listing.
 */
export function postingArrayPointer(
  body: unknown,
  pointer = "",
): string | null {
  if (Array.isArray(body))
    return body.length >= 2 && body.every(looksLikePosting) ? pointer : null;
  if (!body || typeof body !== "object") return null;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const found = postingArrayPointer(value, `${pointer}/${escaped}`);
    if (found !== null) return found;
  }
  return null;
}

export async function runCapture(input: {
  url: string;
}): Promise<CaptureResponse> {
  const origin = new URL(input.url);
  const patterns: CaptureResponse["patterns"] = [];
  const warnings: string[] = [];

  await withSession(origin, async (session) => {
    session.onJsonResponse(async (request, body) => {
      // Ten is plenty for a human to pick from at the review step this
      // feeds; capturing more just spends time and budget on patterns that
      // would never be looked at.
      if (patterns.length >= 10) return;
      const jobsPath = postingArrayPointer(body);
      if (jobsPath === null) return;
      const sample = (
        jobsPath === ""
          ? (body as Record<string, unknown>[])
          : (jsonPointerGet(body, jobsPath) as Record<string, unknown>[])
      ).slice(0, 3);
      // Only headers on the allowlist are ever written out. This is not a
      // best-effort scrub — a cookie or authorization header must never
      // reach the saved pattern, because that pattern is replayed by the
      // worker with no browser and no session of its own.
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (
          capturedHeaderAllowlist.some(
            (allowed) => allowed === key.toLowerCase(),
          )
        )
          headers[key.toLowerCase()] = value;
      }
      patterns.push({
        url: request.url,
        method: request.method,
        headers,
        body: request.body,
        jobsPath,
        sample,
      });
    });
    await session.open(origin);
    await session.settle();
  });

  return captureResponseSchema.parse({
    patterns,
    warnings: warnings.slice(0, 50),
  });
}
