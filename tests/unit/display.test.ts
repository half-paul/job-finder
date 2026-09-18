import { describe, expect, it } from "vitest";
import { salary } from "../../apps/web/lib/display";

describe("salary display", () => {
  it.each(["Unknown", "", "US", "US Dollars", "$", "123"])(
    "renders amounts safely for currency %j",
    (currency) => {
      expect(salary({ salaryMin: 100000, salaryMax: 150000, currency })).toBe(
        "100K – 150K (currency unknown)",
      );
    },
  );

  it.each([
    { salaryMin: null, salaryMax: 150000, expected: "Up to 150K" },
    { salaryMin: 100000, salaryMax: null, expected: "100K+" },
    { salaryMin: 0, salaryMax: 150000, expected: "0 – 150K" },
  ])("preserves salary bounds: $expected", ({ expected, ...bounds }) => {
    expect(salary({ ...bounds, currency: "Unknown" })).toBe(
      `${expected} (currency unknown)`,
    );
  });

  it("handles missing salaries", () => {
    expect(
      salary({ salaryMin: null, salaryMax: null, currency: "Unknown" }),
    ).toBe("Salary not listed");
  });

  it.each(["USD", "usd"])("formats currency %s", (currency) => {
    expect(salary({ salaryMin: 100000, salaryMax: 150000, currency })).toBe(
      "$100K – $150K USD",
    );
  });
});
