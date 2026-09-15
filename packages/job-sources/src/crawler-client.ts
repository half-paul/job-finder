import {
  captureResponseSchema,
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
  timeoutMs?: number;
}

export function createHttpCrawlerClient(
  config: HttpCrawlerConfig,
): CrawlerClient {
  const base = config.url.replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeout = config.timeoutMs ?? 120_000;
  async function call<T>(
    path: string,
    body: unknown,
    parse: (data: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
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