import { CrawlerFailure } from "./failure";

// Real signature so Task 9 inherits the right contract instead of re-deriving
// it; this file is still replaced wholesale.
export async function runCapture(input: { url: string }): Promise<never> {
  throw new CrawlerFailure("Capture is not implemented yet", "internal");
}
