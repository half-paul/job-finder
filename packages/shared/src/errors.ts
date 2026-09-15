/**
 * A failure with an HTTP status attached. The web layer maps it to a response;
 * the worker treats it like any other job error. Kept dependency-free so it can
 * be shared by request handlers and background workers alike.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
