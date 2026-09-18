import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  captureRequestSchema,
  crawlRequestSchema,
  type CrawlerError,
} from "@jobfinder/shared";
import { CrawlerFailure } from "./failure";

const port = Number(process.env.PORT ?? 4000);
const secret = process.env.CRAWLER_SECRET?.trim();
if (!secret) throw new Error("CRAWLER_SECRET is required. See README.md.");

function log(level: "info" | "error", event: string, detail: object = {}) {
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

const readBody = (stream: NodeJS.ReadableStream, limit = 64 * 1024) =>
  new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) reject(new Error("Request body too large"));
      else chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const fail = (status: number, error: string, kind: CrawlerError["kind"]) =>
    send(status, { error, kind });

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
    const kind: CrawlerError["kind"] =
      error instanceof CrawlerFailure ? error.kind : "internal";
    const message = error instanceof Error ? error.message : "Crawler failed";
    log("error", "crawler.request_failed", { url: req.url, message, kind });
    return fail(kind === "internal" ? 500 : 422, message, kind);
  }
});

server.listen(port, () => log("info", "crawler.listening", { port }));
