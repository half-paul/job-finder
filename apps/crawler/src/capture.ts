import { CrawlerFailure } from "./failure";

// Signature accepts the parsed request so index.ts's call site typechecks;
// Task 9 replaces this file wholesale with the real implementation.
export async function runCapture(_request: unknown): Promise<never> {
  throw new CrawlerFailure("Capture is not implemented yet", "internal");
}
