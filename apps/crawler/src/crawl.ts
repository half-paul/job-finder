import type { CrawlRequest } from "@jobfinder/shared";
import { CrawlerFailure } from "./failure";

// Real signature so Task 8 inherits the right contract instead of re-deriving
// it; this file is still replaced wholesale.
export async function runCrawl(input: CrawlRequest): Promise<never> {
  throw new CrawlerFailure("Crawling is not implemented yet", "internal");
}
