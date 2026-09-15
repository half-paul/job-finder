import { createHash } from "node:crypto";

/**
 * Stable SHA-256 digest used for session tokens, canonical job identity and
 * content hashes. Exposed as `@jobfinder/shared/hash` so browser bundles that
 * import the main shared entry point never pull in `node:crypto`.
 */
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Canonical URL form: no fragment, no tracking parameters, sorted query. */
export function canonicalUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
