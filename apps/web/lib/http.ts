import { ZodError } from "zod";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function origin() {
  const value = process.env.APP_ORIGIN;
  if (!value) throw new Error("APP_ORIGIN is required");
  return new URL(value).origin;
}
export function verifyOrigin(request: Request) {
  if (request.headers.get("origin") !== origin())
    throw new HttpError(403, "This request did not come from the application.");
}
export async function readBody(request: Request, limit = 200000) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "The upload is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function readJson(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "Expected JSON.");
  try {
    return JSON.parse((await readBody(request)).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON.");
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError)
    return Response.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  console.error(
    JSON.stringify({
      event: "request_failed",
      type: error instanceof Error ? error.name : "Unknown",
    }),
  );
  return Response.json(
    { error: "The request could not be completed. Please try again." },
    { status: 500 },
  );
}
