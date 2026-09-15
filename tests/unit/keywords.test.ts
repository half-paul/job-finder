import { describe, it, expect } from "vitest";
import {
  keywordFilter,
  postingKeywordText,
  defaultPreferences,
  preferencesSchema,
} from "@jobfinder/shared";

const job = {
  title: "Director of Platform Engineering",
  company: "Northwind Systems",
  description:
    "Lead a cloud platform team. Experience with Kubernetes, Terraform and PCI DSS is required.",
};

const rules = (
  includeKeywords: string[] = [],
  negativeKeywords: string[] = [],
) => ({ includeKeywords, negativeKeywords });

describe("keyword import gate", () => {
  it("imports every listing when no keywords are configured", () => {
    expect(keywordFilter(job, rules()).passed).toBe(true);
    expect(
      keywordFilter(
        { title: "Anything", description: "Nothing configured here." },
        rules(),
      ).passed,
    ).toBe(true);
  });

  it("requires at least one included keyword", () => {
    expect(keywordFilter(job, rules(["platform"])).passed).toBe(true);
    const missing = keywordFilter(job, rules(["data science", "salesforce"]));
    expect(missing).toMatchObject({
      passed: false,
      reason: "No required keyword found",
    });
  });

  it("matches case-insensitively across title, company and description", () => {
    expect(keywordFilter(job, rules(["DIRECTOR OF PLATFORM"])).passed).toBe(
      true,
    );
    expect(keywordFilter(job, rules(["northwind"])).passed).toBe(true);
    expect(keywordFilter(job, rules(["Kubernetes"])).passed).toBe(true);
    // Keyword hits are whole substring matches, so short terms still match.
    expect(keywordFilter(job, rules(["pci dss"])).passed).toBe(true);
  });

  it("treats extra whitespace and blank entries as insignificant", () => {
    expect(
      keywordFilter(job, rules(["  platform   engineering "])).passed,
    ).toBe(true);
    expect(keywordFilter(job, rules(["", "   "])).passed).toBe(false);
  });

  it("never imports a listing that contains a blocking keyword", () => {
    const blocked = keywordFilter(job, rules(["platform"], ["terraform"]));
    expect(blocked).toMatchObject({
      passed: false,
      reason: 'Excluded keyword "terraform"',
      keyword: "terraform",
    });
    // Exclusion wins even when the blocking term is absent from the title.
    expect(keywordFilter(job, rules([], ["  PCI DSS "])).passed).toBe(false);
  });

  it("normalizes the text used for matching", () => {
    expect(
      postingKeywordText(job).startsWith(
        "director of platform engineering northwind systems lead a cloud platform team",
      ),
    ).toBe(true);
    expect(
      postingKeywordText({
        title: "  Head   of  Platform ",
        description: "Line one\n\nLine   two",
      }),
    ).toBe("head of platform line one line two");
  });

  it("validates keyword preferences through the shared contract", () => {
    const parsed = preferencesSchema.parse(defaultPreferences);
    expect(parsed.includeKeywords).toEqual([]);
    expect(parsed.negativeKeywords).toEqual([]);
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        includeKeywords: ["platform engineering", "infrastructure"],
        negativeKeywords: ["commission only"],
      }).success,
    ).toBe(true);
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        includeKeywords: Array.from({ length: 101 }, (_, i) => `k${i}`),
      }).success,
    ).toBe(false);
  });
});
