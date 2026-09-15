const codes =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  );
const names = new Intl.DisplayNames(["en"], { type: "region" });
export const countries = codes
  .map((code) => ({ code, name: names.of(code)! }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));
export const countryCodes = new Set(codes);
const aliases: Record<string, string[]> = {
  US: ["us", "usa", "u.s.", "u.s.a.", "united states of america"],
  GB: [
    "uk",
    "u.k.",
    "great britain",
    "england",
    "scotland",
    "wales",
    "northern ireland",
  ],
  KR: ["south korea"],
  CZ: ["czech republic"],
  TR: ["turkey", "türkiye"],
};
const europe =
  "AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA".split(
    " ",
  );
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = countries.map(({ code, name }) => ({
  code,
  pattern: new RegExp(
    `(?:^|[^a-z])(?:${[name.toLowerCase(), ...(aliases[code] ?? [])].map(escapeRegex).join("|")})(?=$|[^a-z])`,
    "i",
  ),
}));

/** Location evidence only: "Remote" alone never implies worldwide eligibility. */
export function countryCoverage(country: string, location: string) {
  const text = [country, location].join(" ");
  const found = new Set(
    patterns
      .filter(({ pattern }) => pattern.test(text))
      .map(({ code }) => code),
  );
  for (const token of country.split(/[,;/|]/)) {
    const code = token.trim().toUpperCase();
    if (countryCodes.has(code)) found.add(code);
  }
  // An isolated location code is safe; CA within a US street address is not.
  if (countryCodes.has(location.trim().toUpperCase()))
    found.add(location.trim().toUpperCase());
  if (/\beurope(?:an union)?\b/i.test(text))
    europe.forEach((code) => found.add(code));
  return {
    codes: [...found],
    worldwide:
      /\b(worldwide|anywhere|global|world wide|work from anywhere)\b/i.test(
        text,
      ) && found.size === 0,
  };
}

export type CountryPreferences = {
  countries: string[];
  includeWorldwideJobs: boolean;
  includeUnknownCountryJobs: boolean;
};
export function matchesCountries(
  job: { country: string; location: string },
  preferences: CountryPreferences,
) {
  if (!preferences.countries.length) return true;
  const coverage = countryCoverage(job.country, job.location);
  if (coverage.codes.length)
    return coverage.codes.some((code) => preferences.countries.includes(code));
  return coverage.worldwide
    ? preferences.includeWorldwideJobs
    : preferences.includeUnknownCountryJobs;
}
