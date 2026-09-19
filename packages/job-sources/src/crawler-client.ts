import {
  captureResponseSchema,
  crawlClientTimeoutMs,
  crawlResponseSchema,
  crawlerErrorSchema,
  type CaptureResponse,
  type CrawlRequest,
  type CrawlResponse,
  type CrawlerError,
} from "@jobfinder/shared";

/** The worker's view of the isolated browser service. Tests inject a fake. */
export interface CrawlerClient {
  crawl(input: CrawlRequest, signal?: AbortSignal): Promise<CrawlResponse>;
  capture(
    input: { url: string },
    signal?: AbortSignal,
  ): Promise<CaptureResponse>;
}

export class CrawlerRequestError extends Error {
  constructor(
    message: string,
    public readonly kind: CrawlerError["kind"],
  ) {
    super(message);
    this.name = "CrawlerRequestError";
  }
}

export interface HttpCrawlerConfig {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  /** Overrides `crawlClientTimeoutMs`; only tests have a reason to. */
  timeoutMs?: number;
}

export function createHttpCrawlerClient(
  config: HttpCrawlerConfig,
): CrawlerClient {
  const base = config.url.replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  // Imported, never restated. The crawler sizes its own lock wait, session
  // budget and overhead to fit inside this number with margin to spare
  // (`packages/shared/src/crawler.ts`), and a literal here is exactly how the
  // two sides drifted far enough apart that a second crawl of the same host
  // was aborted by this timeout after doing all of its work.
  const timeout = config.timeoutMs ?? crawlClientTimeoutMs;
  async function call<T>(
    path: string,
    body: unknown,
    parse: (data: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      // The bearer secret must not follow a redirect to somewhere unintended.
      redirect: "error",
      headers: {
        authorization: `Bearer ${config.secret}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new CrawlerRequestError(
        "Crawler returned invalid JSON",
        "internal",
      );
    }
    if (!response.ok) {
      const failure = crawlerErrorSchema.safeParse(data);
      throw new CrawlerRequestError(
        failure.success
          ? failure.data.error
          : `Crawler returned HTTP ${response.status}`,
        failure.success ? failure.data.kind : "internal",
      );
    }
    try {
      return parse(data);
    } catch {
      throw new CrawlerRequestError(
        "Crawler returned an invalid response",
        "internal",
      );
    }
  }
  return {
    crawl: (input, signal) =>
      call("/crawl", input, (d) => crawlResponseSchema.parse(d), signal),
    capture: (input, signal) =>
      call("/capture", input, (d) => captureResponseSchema.parse(d), signal),
  };
}

/** Null means the browser rung is unavailable; callers must say so, not stub it. */
export function crawlerClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): CrawlerClient | null {
  const url = env.CRAWLER_URL?.trim();
  const secret = env.CRAWLER_SECRET?.trim();
  if (!url || !secret) return null;
  return createHttpCrawlerClient({ url, secret });
}

/**
 * Merges a caller-supplied crawler client with the environment default. An
 * explicit `null` means the caller is telling us there is no crawler — e.g. a
 * test disabling the browser rung — and must win over the environment; `??`
 * cannot express that because it treats `null` and `undefined` the same. Only
 * an absent (`undefined`) option falls back to `crawlerClientFromEnv`.
 */
export function resolveCrawlerClient(
  explicit: CrawlerClient | null | undefined,
  env: Record<string, string | undefined> = process.env,
): CrawlerClient | null {
  return explicit !== undefined ? explicit : crawlerClientFromEnv(env);
}
