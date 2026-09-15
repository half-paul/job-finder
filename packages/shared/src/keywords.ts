/** Posting fields that keyword rules inspect. */
export interface KeywordTarget {
  title: string;
  company?: string;
  description: string;
}

export interface KeywordPreferences {
  includeKeywords: string[];
  negativeKeywords: string[];
}

export type KeywordFilterResult =
  { passed: true } | { passed: false; reason: string; keyword: string };

/** Case-insensitive, whitespace-collapsed text used for every keyword rule. */
export const normalizeKeywordText = (value: string) =>
  value.toLowerCase().replace(/\s+/g, " ").trim();

export function postingKeywordText(job: KeywordTarget) {
  return normalizeKeywordText(
    [job.title, job.company ?? "", job.description].join(" "),
  );
}

function firstMatch(haystack: string, keywords: string[]) {
  return keywords
    .map(normalizeKeywordText)
    .find((needle) => needle && haystack.includes(needle));
}

/**
 * Import gate for discovered listings. Excluded keywords always win, so a
 * listing is never imported when it contains one. When required keywords are
 * configured the listing must mention at least one of them.
 */
export function keywordFilter(
  job: KeywordTarget,
  preferences: KeywordPreferences,
): KeywordFilterResult {
  const text = postingKeywordText(job);
  const excluded = firstMatch(text, preferences.negativeKeywords);
  if (excluded)
    return {
      passed: false,
      reason: `Excluded keyword "${excluded}"`,
      keyword: excluded,
    };
  if (preferences.includeKeywords.length === 0) return { passed: true };
  const included = firstMatch(text, preferences.includeKeywords);
  if (!included)
    return {
      passed: false,
      reason: "No required keyword found",
      keyword: "",
    };
  return { passed: true };
}
