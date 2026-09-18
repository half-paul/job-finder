import { CrawlerFailure } from "./failure";

// Signature accepts the parsed request so index.ts's call site typechecks;
// Task 8 replaces this file wholesale with the real implementation.
export async function runCrawl(_request: unknown): Promise<never> {
  throw new CrawlerFailure("Crawling is not implemented yet", "internal");
}
