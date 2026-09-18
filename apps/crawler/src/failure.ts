import type { CrawlerError } from "@jobfinder/shared";

/** Thrown by crawl/capture so the HTTP layer can pick the right `kind`. */
export class CrawlerFailure extends Error {
  constructor(
    message: string,
    public readonly kind: CrawlerError["kind"],
  ) {
    super(message);
    this.name = "CrawlerFailure";
  }
}
