import { describe, expect, it } from "vitest";
import { captureFromSession } from "../../apps/crawler/src/capture";
import type {
  CapturedJsonRequest,
  Session,
} from "../../apps/crawler/src/session";

/**
 * Drives `captureFromSession` against a `Session` this test controls
 * entirely — no browser, no network — the same separation `createSession`
 * gets from `withSession` in `session.ts`. This is what makes the warning
 * channel testable at all: the real drops it reports (oversize, the pattern
 * cap) originate deep inside a live page's network traffic.
 *
 * `open()` stays pending until `finishOpen()` is called. Without that, the
 * fake's trivially-resolving `open`/`settle` let `captureFromSession` reach
 * its final `captureResponseSchema.parse` after only a couple of microtask
 * ticks — racing ahead of a test's own `await emit(...)` loop and snapshotting
 * `patterns` long before every response has actually arrived. Real
 * `onJsonResponse` calls land while `open()`'s networkidle wait is still in
 * flight; this reproduces that ordering instead of assuming it away.
 */
function fakeSession() {
  const responseHandlers: Array<
    (request: CapturedJsonRequest, body: unknown) => Promise<void>
  > = [];
  const skipHandlers: Array<(url: string, reason: string) => void> = [];
  let releaseOpen!: () => void;
  const opened = new Promise<void>((resolve) => (releaseOpen = resolve));
  const session: Session = {
    async open() {
      await opened;
      return "<html></html>";
    },
    onJsonResponse(handler) {
      responseHandlers.push(handler);
    },
    onJsonSkip(handler) {
      skipHandlers.push(handler);
    },
    async settle() {},
  };
  return {
    session,
    async emit(request: CapturedJsonRequest, body: unknown) {
      for (const handler of responseHandlers) await handler(request, body);
    },
    emitSkip(url: string, reason: string) {
      for (const handler of skipHandlers) handler(url, reason);
    },
    finishOpen() {
      releaseOpen();
    },
  };
}

const postings = {
  data: {
    results: [
      { title: "A", url: "/a" },
      { title: "B", url: "/b" },
    ],
  },
};

describe("capture warnings", () => {
  it("records a warning when a response is skipped for its size", async () => {
    const { session, emitSkip, finishOpen } = fakeSession();
    const origin = new URL("https://acme.example/careers");
    const result = captureFromSession(session, origin);
    emitSkip(
      "https://acme.example/api/jobs",
      "is 5000000 bytes, at or over the 4194304-byte capture limit",
    );
    finishOpen();
    const response = await result;
    expect(response.patterns).toHaveLength(0);
    expect(
      response.warnings.some(
        (w) => w.includes("api/jobs") && w.includes("4194304"),
      ),
    ).toBe(true);
  });

  it("stops at 10 patterns and records exactly one warning about the cap", async () => {
    const { session, emit, finishOpen } = fakeSession();
    const origin = new URL("https://acme.example/careers");
    const result = captureFromSession(session, origin);
    for (let page = 0; page < 13; page++) {
      await emit(
        {
          url: `https://acme.example/api/jobs?page=${page}`,
          method: "GET",
          headers: {},
          body: null,
        },
        postings,
      );
    }
    finishOpen();
    const response = await result;
    expect(response.patterns).toHaveLength(10);
    const capWarnings = response.warnings.filter((w) =>
      w.includes("Stopped after 10 captured patterns"),
    );
    expect(capWarnings).toHaveLength(1);
  });

  it("drops a single oversized pattern without discarding the rest", async () => {
    const { session, emit, finishOpen } = fakeSession();
    const origin = new URL("https://acme.example/careers");
    const result = captureFromSession(session, origin);
    // A POST body over capturedRequestSchema's 10,000-character cap must
    // sink only this one pattern, not throw the final schema parse and
    // discard every pattern the session found.
    await emit(
      {
        url: "https://acme.example/api/jobs",
        method: "POST",
        headers: {},
        body: "x".repeat(10_001),
      },
      postings,
    );
    await emit(
      {
        url: "https://acme.example/api/jobs-ok",
        method: "GET",
        headers: {},
        body: null,
      },
      postings,
    );
    finishOpen();
    const response = await result;
    expect(response.patterns).toHaveLength(1);
    expect(response.patterns[0]?.url).toBe("https://acme.example/api/jobs-ok");
    expect(
      response.warnings.some((w) => w.includes("Dropped a capture pattern")),
    ).toBe(true);
  });

  it("truncates a warning whose URL would push it past the 500-char schema bound", async () => {
    const { session, emitSkip, finishOpen } = fakeSession();
    const origin = new URL("https://acme.example/careers");
    const result = captureFromSession(session, origin);
    // A ~600-char pathname alone, before the "Skipped a JSON response
    // from …: …" wrapper text is even added, is already past
    // captureResponseSchema's per-warning cap of 500. If `warn()` didn't
    // truncate, this would throw inside `captureResponseSchema.parse` and
    // the whole capture — every pattern and every warning — would be lost.
    const longPath = `/${"a".repeat(600)}`;
    emitSkip(`https://acme.example${longPath}`, "is over the capture limit");
    finishOpen();
    const response = await result;
    expect(response.warnings).toHaveLength(1);
    expect(response.warnings[0]!.length).toBeLessThanOrEqual(500);
  });

  it("strips the query string from a URL mentioned in a warning", async () => {
    const { session, emitSkip, finishOpen } = fakeSession();
    const origin = new URL("https://acme.example/careers");
    const result = captureFromSession(session, origin);
    emitSkip(
      "https://acme.example/api/jobs?token=super-secret-value",
      "is over the capture limit",
    );
    finishOpen();
    const response = await result;
    const warning = response.warnings.find((w) => w.includes("api/jobs"));
    expect(warning).toBeDefined();
    expect(warning).not.toContain("token");
    expect(warning).not.toContain("super-secret-value");
    expect(warning).not.toContain("?");
  });

  it("bounds deeply nested junk in a sample so the response still serialises", async () => {
    const { session, emit, finishOpen } = fakeSession();
    const origin = new URL("https://acme.example/careers");
    const result = captureFromSession(session, origin);
    // The same shape C1 exploited through postingArrayPointer's search, now
    // aimed at a field the search never looks at: a real title/url pair
    // sitting next to junk nested far past the stack's comfort zone.
    let junk: unknown = "leaf";
    for (let i = 0; i < 5000; i++) junk = { junk };
    const body = {
      data: {
        results: [
          { title: "A", url: "/a", junk },
          { title: "B", url: "/b" },
        ],
      },
    };
    await emit(
      {
        url: "https://acme.example/api/jobs",
        method: "GET",
        headers: {},
        body: null,
      },
      body,
    );
    finishOpen();
    const response = await result;
    expect(response.patterns).toHaveLength(1);
    // The real bug this guards was index.ts's JSON.stringify(payload)
    // throwing on a body exactly this shape; reproducing that call here
    // is the point, not an implementation detail.
    expect(() => JSON.stringify(response)).not.toThrow();
  });
});
