import { describe, expect, it } from "vitest";
import {
  candidateStatusLabel,
  companyImportSchema,
  crawlPatternSpecSchema,
  crawlResponseSchema,
  jsonPointerGet,
} from "@jobfinder/shared";

describe("Phase 5 shared discovery contracts", () => {
  it("labels every candidate status in plain language", () => {
    expect(candidateStatusLabel.Pending).toBe("Waiting for worker");
    expect(candidateStatusLabel.Blocked).toBe("Robots.txt disallows crawling");
    expect(candidateStatusLabel.Unsupported).toBe(
      "Vendor recognised, not yet supported",
    );
  });

  it("bounds the import body", () => {
    expect(companyImportSchema.parse({ text: "acme.com" })).toEqual({
      text: "acme.com",
    });
    expect(
      companyImportSchema.safeParse({ text: "x".repeat(200_001) }).success,
    ).toBe(false);
  });

  it("reads JSON pointers including escaped segments", () => {
    const value = { data: { "a/b": [{ title: "One" }] } };
    expect(jsonPointerGet(value, "/data/a~1b/0/title")).toBe("One");
    expect(jsonPointerGet(value, "")).toBe(value);
    expect(jsonPointerGet(value, "/missing/x")).toBeUndefined();
  });

  it("rejects crawler responses that exceed caps or use plain HTTP", () => {
    expect(
      crawlResponseSchema.safeParse({
        jobs: [{ title: "Engineer", url: "http://example.com/j/1" }],
        complete: true,
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      crawlPatternSpecSchema.safeParse({
        urlTemplate: "https://example.com/api/jobs?page={page}",
        method: "GET",
        headers: { accept: "application/json" },
        body: null,
        jobsPath: "/jobs",
        fieldMap: { title: "/title", url: "/url" },
      }).success,
    ).toBe(true);
  });
});
