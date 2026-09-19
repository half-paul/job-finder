import type { CrawlerError } from "@jobfinder/shared";

/** Thrown by crawl/capture so the HTTP layer can pick the right `kind`. */
export class CrawlerFailure extends Error {
  constructor(
    message: string,
    public readonly kind: CrawlerError["kind"],
    /**
     * True when this failure ends the whole crawl rather than just the one
     * page that raised it. `kind` alone cannot carry this: a session-budget
     * timeout and a single slow page's `goto` timeout are both `"timeout"`,
     * but only the former means every remaining page would fail the same
     * way. Defaults to false so an ordinary per-page failure (a 404, a slow
     * page) is skippable unless a caller says otherwise.
     */
    public readonly fatal: boolean = false,
  ) {
    super(message);
    this.name = "CrawlerFailure";
  }
}
