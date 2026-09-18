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
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
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
