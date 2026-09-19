import { globalSourceProviders } from "@jobfinder/shared";
export function salary(job: {
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
}) {
  if (job.salaryMin === null && job.salaryMax === null)
    return "Salary not listed";
  const currency = /^[a-z]{3}$/i.test(job.currency)
    ? job.currency.toUpperCase()
    : null;
  const formatter = new Intl.NumberFormat("en", {
    ...(currency ? { style: "currency", currency } : { style: "decimal" }),
    maximumFractionDigits: 0,
    notation: "compact",
  });
  const fmt = (value: number) => formatter.format(value);
  return `${job.salaryMin === null ? "Up to " : fmt(job.salaryMin)}${job.salaryMin !== null && job.salaryMax !== null ? " – " : ""}${job.salaryMax !== null ? fmt(job.salaryMax) : "+"} ${currency ?? "(currency unknown)"}`;
}

type GlobalProvider = (typeof globalSourceProviders)[number];

/**
 * Only the providers whose display name differs from the stored enum value. The
 * key type is the enum itself, so a new CamelCase provider is a compile error
 * here rather than an unspaced label in the UI.
 */
const providerLabels: Partial<Record<GlobalProvider, string>> = {
  TheMuse: "The Muse",
  WeWorkRemotely: "We Work Remotely",
};

/** Feeds that only run once their API credentials are configured. */
const keyedProviders: readonly GlobalProvider[] = ["USAJOBS", "Adzuna"];

/**
 * An explicit locale keeps server-rendered and client-rendered numbers
 * identical; the ambient Node and browser locales can differ and that is a
 * hydration mismatch.
 */
const numbers = new Intl.NumberFormat("en");
export const count = (value: number) => numbers.format(value);

/** The provider's display name on its own, for tables and tags. */
export function providerName(provider: string) {
  return providerLabels[provider as GlobalProvider] ?? provider;
}

export function providerLabel(provider: string) {
  const name = providerName(provider);
  return keyedProviders.includes(provider as GlobalProvider)
    ? `${name} (needs API key)`
    : name;
}
