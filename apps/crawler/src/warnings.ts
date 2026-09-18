/**
 * Shared between `crawl.ts` and `capture.ts`: both build a `warnings: string[]`
 * that is validated against `z.array(z.string().max(500)).max(50)`
 * (`crawlResponseSchema`/`captureResponseSchema` in `@jobfinder/shared`).
 * Bounding is done once, here, so neither channel — nor a future one — can
 * reintroduce the failure where an attacker-controlled URL or error message
 * makes a single warning too long, which throws that schema's `.parse()` and
 * discards the ENTIRE response: every captured pattern, or every job a
 * crawl found, for the sake of one skipped item's warning text.
 */

/** Matches the schemas' per-warning cap. */
export const maxWarningLength = 500;
/** Matches the schemas' cap on the warnings array itself. */
export const maxWarnings = 50;

/**
 * origin + pathname only, never the query string or fragment. A warning is
 * about something deliberately NOT kept (a skipped response, a posting that
 * failed to parse); a URL that failed to parse returns a fixed placeholder
 * rather than the raw input, because a redaction helper that falls back to
 * the very thing it exists to redact is backwards — even though every
 * current caller only ever passes an already-valid absolute URL, so this
 * path is not known to be reachable today.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[unparseable url]";
  }
}

/**
 * A bounded warning collector: caps how many warnings are kept and truncates
 * each one, centrally, so no call site has to remember to.
 */
export function createWarningCollector(): {
  push(message: string): void;
  list(): string[];
} {
  const warnings: string[] = [];
  return {
    push(message: string) {
      if (warnings.length < maxWarnings)
        warnings.push(message.slice(0, maxWarningLength));
    },
    list() {
      return warnings;
    },
  };
}
