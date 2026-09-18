import { isIP } from "node:net";
import { assertHttpsUrl } from "@jobfinder/job-sources";

export interface SeedRow {
  name: string;
  domain: string;
  websiteUrl?: string;
}

export interface SeedListResult {
  rows: SeedRow[];
  rejected: { line: number; reason: string }[];
}

export const seedListLimit = 500;
const fieldLimit = 200;

/** Suffixes where the registrable domain has three labels. Small, built in. */
const twoLevelSuffixes = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.kr",
  "co.in",
  "co.za",
  "com.br",
  "com.mx",
  "com.ar",
  "com.sg",
  "com.hk",
  "com.tr",
  "co.il",
]);

/** Lowercase registrable domain, or null when the host is not a public name. */
export function registrableDomain(host: string): string | null {
  const cleaned = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!cleaned || isIP(cleaned) || !cleaned.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(cleaned) || cleaned.includes("..")) return null;
  const labels = cleaned.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = twoLevelSuffixes.has(lastTwo) ? 3 : 2;
  if (labels.length < keep) return null;
  return labels.slice(-keep).join(".");
}

export function websiteFromToken(token: string): string | null {
  const value = token.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  try {
    const url = new URL(
      /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`,
    );
    if (url.protocol === "http:") url.protocol = "https:";
    assertHttpsUrl(url);
    if (!registrableDomain(url.hostname)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Minimal RFC 4180 line split: quoted fields may contain commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(current);
      current = "";
    } else current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

const headerPattern = /^(company|name|website|domain|url)$/i;

/**
 * Accepts pasted lines (`Acme, acme.com`, `acme.com`, a URL) or CSV with a
 * `name,domain`-style header. Nothing is guessed from a bare company name.
 */
export function parseSeedList(text: string): SeedListResult {
  const rows: SeedRow[] = [];
  const rejected: SeedListResult["rejected"] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  let nameIndex = 0;
  let domainIndex = -1;
  let first = true;
  lines.forEach((raw, offset) => {
    const line = offset + 1;
    if (!raw.trim()) return;
    const fields = splitCsvLine(raw.replace(/^\uFEFF/, "").replace(/\t/g, ","));
    if (
      first &&
      fields.length >= 1 &&
      fields.every((f) => headerPattern.test(f))
    ) {
      first = false;
      nameIndex = fields.findIndex((f) => /^(company|name)$/i.test(f));
      domainIndex = fields.findIndex((f) => /^(website|domain|url)$/i.test(f));
      return;
    }
    first = false;
    let websiteUrl: string | null = null;
    let name = "";
    let domain: string | null = null;
    if (domainIndex >= 0) {
      websiteUrl = websiteFromToken(fields[domainIndex] ?? "");
      domain = websiteUrl
        ? new URL(websiteUrl).hostname.replace(/^www\./, "")
        : null;
      name = fields[nameIndex] ?? "";
    } else {
      for (const field of fields) {
        const candidate = websiteFromToken(field);
        if (candidate && !domain) {
          websiteUrl = candidate;
          domain = new URL(candidate).hostname.replace(/^www\./, "");
        } else if (!name && field && !candidate) name = field;
      }
    }
    if (!domain) {
      rejected.push({ line, reason: "No domain found" });
      return;
    }
    if (seen.has(domain)) {
      rejected.push({ line, reason: "Duplicate domain" });
      return;
    }
    if (rows.length >= seedListLimit) {
      rejected.push({ line, reason: `Import limit is ${seedListLimit} rows` });
      return;
    }
    if (name.length > fieldLimit || domain.length > fieldLimit) {
      rejected.push({ line, reason: "Company name or domain is too long" });
      return;
    }
    seen.add(domain);
    rows.push({
      name: (name || domain).slice(0, fieldLimit),
      domain,
      ...(websiteUrl && websiteUrl !== `https://${domain}/`
        ? { websiteUrl }
        : {}),
    });
  });
  return { rows, rejected };
}
