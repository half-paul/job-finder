import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export class SourceHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(`Source returned HTTP ${status}`);
    this.name = "SourceHttpError";
  }
}

export function retryAfterMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim()))
    return Math.min(Number(value) * 1000, 7 * 86400000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(0, parsed - now), 7 * 86400000)
    : undefined;
}

/** Only globally routable addresses are acceptable; IPv6 is deliberately conservative. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Global unicast only, excluding documentation, transition and special-use blocks.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^(2001:(?:0:|db8:|[12][0-9a-f]:)|2002:|3fff:)/i.test(address)
  );
}

export function assertHttpsUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hostname.endsWith(".") ||
    !url.hostname.includes(".") ||
    isIP(url.hostname.replace(/^\[|\]$/g, ""))
  ) {
    throw new Error(
      "Source URL must use HTTPS on a public hostname without credentials or a custom port",
    );
  }
}

export interface TransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** GET unless a captured pattern says POST. */
  method?: "GET" | "POST";
  /** Raw request body; only sent with POST. */
  body?: string;
  /** Dependency injection for deterministic tests; never populated from source config. */
  fetchImpl?: typeof fetch;
  resolveHost?: (
    hostname: string,
  ) => Promise<{ address: string; family: number }[]>;
}

export async function fetchText(
  url: URL,
  headers: Record<string, string>,
  options: TransportOptions,
): Promise<{ response: Response; text: string }> {
  assertHttpsUrl(url);
  const timeout = Math.min(Math.max(options.timeoutMs ?? 15000, 1), 30000);
  const maxBytes = Math.min(
    Math.max(options.maxBytes ?? 8 * 1024 * 1024, 1),
    16 * 1024 * 1024,
  );
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(options.signal ? [options.signal] : []),
  ]);
  const method = options.method ?? "GET";
  const body = method === "POST" ? (options.body ?? "") : undefined;
  const requestHeaders = {
    "User-Agent": "JobFinder/1.0",
    "Accept-Encoding": "identity",
    ...headers,
  };
  if (options.fetchImpl) {
    const response = await options.fetchImpl(url, {
      method,
      body,
      headers: requestHeaders,
      redirect: "error",
      signal,
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes)
            throw new Error("Source response exceeds size limit");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
    }
    return { response, text: Buffer.concat(chunks).toString("utf8") };
  }
  // Resolve once and pin the verified address at connection time, preventing DNS rebinding.
  const resolve =
    options.resolveHost ?? ((host: string) => lookup(host, { all: true }));
  const addresses = await Promise.race([
    resolve(url.hostname),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    }),
  ]);
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("Source DNS resolved to a non-public address");
  }
  const pinned = addresses[0];
  return new Promise((resolveResponse, reject) => {
    const req = request(
      url,
      {
        method,
        headers: {
          ...requestHeaders,
          ...(body !== undefined
            ? { "Content-Length": String(Buffer.byteLength(body)) }
            : {}),
        },
        signal,
        agent: false,
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes)
            req.destroy(new Error("Source response exceeds size limit"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              responseHeaders.set(
                key,
                Array.isArray(value) ? value.join(", ") : value,
              );
          }
          resolveResponse({
            response: new Response(null, {
              status: res.statusCode ?? 502,
              headers: responseHeaders,
            }),
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
