import {
  capturedHeaderAllowlist,
  capturedRequestSchema,
  captureResponseSchema,
  jsonPointerGet,
  type CaptureResponse,
} from "@jobfinder/shared";
import { withSession, type Session } from "./session";

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
 * Far above any real API shape (a genuine listings payload nests a handful of
 * levels deep) and far below where recursing would actually threaten the
 * stack. Without this, a same-origin 200 `application/json` body that is
 * merely deeply nested — not large; V8's own parser is iterative and accepts
 * it — walks past `RangeError: Maximum call stack size exceeded` here, and an
 * unguarded rejection from that used to take the whole process down with it
 * (see the `.catch()` on the response listener in `session.ts`). Exceeding
 * the cap means "not a postings array", the same as never finding one.
 */
const maxPointerDepth = 100;

/**
 * The JSON pointer to the first array of two or more posting-shaped objects.
 * Two is the floor because a one-element array is as likely to be a banner or
 * a featured role as a listing.
 */
export function postingArrayPointer(
  body: unknown,
  pointer = "",
  depth = 0,
): string | null {
  if (depth > maxPointerDepth) return null;
  if (Array.isArray(body))
    return body.length >= 2 && body.every(looksLikePosting) ? pointer : null;
  if (!body || typeof body !== "object") return null;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const found = postingArrayPointer(
      value,
      `${pointer}/${escaped}`,
      depth + 1,
    );
    if (found !== null) return found;
  }
  return null;
}

/** Bounds `warnings` while a session is still live, not just at the end. */
const maxWarnings = 50;

/**
 * The real capture logic, separated from `withSession`'s browser/lock
 * plumbing the same way `createSession` is in `session.ts`: this is what a
 * test drives directly, against a `Session` it controls, with no browser.
 */
export async function captureFromSession(
  session: Session,
  origin: URL,
): Promise<CaptureResponse> {
  const patterns: CaptureResponse["patterns"] = [];
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.length < maxWarnings) warnings.push(message);
  };
  // Reported once, not once per response after the cap: every later match is
  // dropped for the same reason and a warning per hit would just spend the
  // 50-warning budget on repeating itself.
  let patternCapWarned = false;

  session.onJsonSkip((url, reason) => {
    warn(`Skipped a JSON response from ${url}: ${reason}`);
  });

  session.onJsonResponse(async (request, body) => {
    // Ten is plenty for a human to pick from at the review step this feeds;
    // capturing more just spends time and budget on patterns that would
    // never be looked at.
    if (patterns.length >= 10) {
      if (!patternCapWarned) {
        warn(
          `Stopped after 10 captured patterns; ${request.url} and any further matches were not recorded`,
        );
        patternCapWarned = true;
      }
      return;
    }
    const jobsPath = postingArrayPointer(body);
    if (jobsPath === null) return;
    const sample = (
      jobsPath === ""
        ? (body as Record<string, unknown>[])
        : (jsonPointerGet(body, jobsPath) as Record<string, unknown>[])
    ).slice(0, 3);
    // Only headers on the allowlist are ever written out. This is not a
    // best-effort scrub — a cookie or authorization header must never reach
    // the saved pattern, because that pattern is replayed by the worker with
    // no browser and no session of its own.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (
        capturedHeaderAllowlist.some((allowed) => allowed === key.toLowerCase())
      )
        headers[key.toLowerCase()] = value;
    }
    // Validated individually, not as part of the batch at the end: a header
    // or body field over its cap on one pattern must drop only that pattern,
    // not throw `captureResponseSchema.parse` and discard every pattern this
    // session found.
    const parsed = capturedRequestSchema.safeParse({
      url: request.url,
      method: request.method,
      headers,
      body: request.body,
      jobsPath,
      sample,
    });
    if (!parsed.success) {
      warn(
        `Dropped a capture pattern for ${request.url}: ${parsed.error.issues[0]?.message ?? "failed validation"}`,
      );
      return;
    }
    patterns.push(parsed.data);
  });

  await session.open(origin);
  await session.settle();

  return captureResponseSchema.parse({ patterns, warnings });
}

export async function runCapture(input: {
  url: string;
}): Promise<CaptureResponse> {
  const origin = new URL(input.url);
  return withSession(origin, (session) => captureFromSession(session, origin));
}
