import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  captureRequestSchema,
  crawlRequestSchema,
  type CrawlerError,
} from "@jobfinder/shared";
import { CrawlerFailure } from "./failure";

/** Thrown by `readBody` on the oversize path — a client fault, not ours. */
class PayloadTooLargeError extends Error {}

const port = Number(process.env.PORT ?? 4000);
const secret = process.env.CRAWLER_SECRET?.trim();
if (!secret) throw new Error("CRAWLER_SECRET is required. See README.md.");

function log(
  level: "info" | "warn" | "error",
  event: string,
  detail: object = {},
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...detail,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

// Defence in depth, not the fix: `session.ts`'s own response listener now
// catches its own rejections (an untrusted page must not be able to crash
// this process by triggering one). This exists so a *future* unguarded
// `void someAsyncFn()` anywhere in the crawler — over pages we do not
// control — degrades to one logged failure instead of taking down every
// concurrent crawl. Node 24 terminates the process on an unhandled
// rejection by default; this is what stops that from being reintroduced
// silently.
process.on("unhandledRejection", (reason) => {
  // This line must read as a fault, not routine noise: every place we know
  // about (session.ts's response listener) already catches its own
  // rejections, so anything reaching here is a bug somewhere that let one
  // escape — worth paging on, not scrolling past.
  log("error", "crawler.unhandled_rejection", {
    fault:
      "An async rejection escaped every local .catch() — this should be impossible; a bug let it through",
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

/** Constant-time compare so the secret cannot be guessed byte by byte. */
function authorised(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret!);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

const readBody = (stream: IncomingMessage, limit = 64 * 1024) =>
  new Promise<string>((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    // Guards both branches below: a stream we've already destroyed or
    // resolved must not be able to resolve/reject a second time.
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      run();
    };
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > limit) {
        // Stop reading immediately rather than draining to 'end': a client
        // trickling bytes past the cap would otherwise keep this connection
        // (and its file descriptor) open indefinitely.
        stream.destroy();
        settle(() =>
          reject(new PayloadTooLargeError("Request body too large")),
        );
      } else {
        chunks.push(chunk);
      }
    });
    stream.on("end", () => {
      settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    // destroy() above can itself raise 'error' (e.g. on abrupt socket
    // teardown). The promise is already settled by then, so this listener's
    // only job at that point is to exist — an EventEmitter with no 'error'
    // listener crashes the process on emit; settle() makes the reject a
    // no-op once we've already settled.
    stream.on("error", (err) => {
      settle(() => reject(err));
    });
  });

const server = createServer(async (req, res) => {
  const send = (status: number, payload: unknown) => {
    // A prior call already wrote the head (e.g. `writeHead`/`end` itself
    // threw after a successful `JSON.stringify`, and the caller's catch
    // re-entered here via `fail()`). Writing headers twice throws
    // `ERR_HTTP_HEADERS_SENT`, so once they're sent there is nothing left
    // for this function to safely do.
    if (res.headersSent) return;
    // Serialised BEFORE the head is written, deliberately: writing the
    // status line first and only then discovering the body can't be built
    // (a `RangeError` from stringifying something too deeply nested, in
    // particular — see `capture.ts`'s `sample` depth bound, which now
    // exists precisely so this branch stays cold) commits a response the
    // caller can never get a matching body for. `res.writeHead` is not
    // undoable. This protects every endpoint that calls `send`, not only
    // `/capture`.
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch (error) {
      log("error", "crawler.serialization_failed", {
        url: req.url,
        method: req.method,
        error: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Failed to serialise response",
          kind: "internal",
        }),
      );
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };
  const fail = (status: number, error: string, kind: CrawlerError["kind"]) => {
    // This service is reachable on the Compose network and runs untrusted pages,
    // so a rejected request must leave a trace — an unlogged 401 is an invisible probe.
    // Never log the authorization header or body: a rejected credential logged is
    // worse than not logging at all.
    // 5xx means we broke; 4xx means the caller did. Error-level alerting must
    // only fire for the former, or a genuine crash blends into routine refusals.
    const level = status >= 500 ? "error" : "warn";
    log(level, "crawler.request_refused", {
      url: req.url,
      method: req.method,
      status,
      kind,
      error,
    });
    send(status, { error, kind });
  };

  try {
    if (req.method !== "POST") return fail(405, "Use POST", "internal");
    if (!authorised(req.headers.authorization))
      return fail(401, "Bearer token required", "internal");

    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "Request body must be JSON", "internal");
    }

    if (req.url === "/crawl") {
      const parsed = crawlRequestSchema.safeParse(body);
      if (!parsed.success)
        return fail(400, "Invalid crawl request", "internal");
      const { runCrawl } = await import("./crawl");
      return send(200, await runCrawl(parsed.data));
    }
    if (req.url === "/capture") {
      const parsed = captureRequestSchema.safeParse(body);
      if (!parsed.success)
        return fail(400, "Invalid capture request", "internal");
      const { runCapture } = await import("./capture");
      return send(200, await runCapture(parsed.data));
    }
    return fail(404, "Unknown endpoint", "internal");
  } catch (error) {
    // fail() logs this refusal too, so there is exactly one log line per
    // rejected request whether it returned early or was thrown.
    const kind: CrawlerError["kind"] =
      error instanceof CrawlerFailure ? error.kind : "internal";
    const message = error instanceof Error ? error.message : "Crawler failed";
    // An oversize body is the caller's fault, not ours — crawlerErrorKinds
    // has no "bad request" member, so kind stays "internal" (matching the
    // existing "Request body must be JSON" precedent) while the status
    // still reflects a 4xx.
    const status =
      error instanceof PayloadTooLargeError
        ? 413
        : kind === "internal"
          ? 500
          : 422;
    return fail(status, message, kind);
  }
});

server.listen(port, () => log("info", "crawler.listening", { port }));
