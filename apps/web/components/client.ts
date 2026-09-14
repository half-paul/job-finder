export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers:
      body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data === "object" && data !== null && "error" in data
        ? String(data.error)
        : "Request failed.",
    );
  return data as T;
}
