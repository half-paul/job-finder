import { describe, expect, it } from "vitest";
import {
  createWarningCollector,
  maxWarningLength,
  redactUrl,
} from "../../apps/crawler/src/warnings";

describe("redactUrl", () => {
  it("keeps origin and pathname, drops the query string and fragment", () => {
    expect(redactUrl("https://acme.example/api/jobs?token=secret#frag")).toBe(
      "https://acme.example/api/jobs",
    );
  });

  it("falls back to a fixed placeholder, never the raw input, on a parse failure", () => {
    // A redaction helper whose failure mode is "return the thing I could not
    // redact" is backwards — even though no current caller passes anything
    // unparseable, the fallback itself must not be able to leak a query
    // string a future caller's malformed input happened to carry.
    const unparseable = "not a url ?token=leaked-if-fallback-echoes-input";
    const result = redactUrl(unparseable);
    expect(result).toBe("[unparseable url]");
    expect(result).not.toContain("token");
    expect(result).not.toContain("leaked");
  });
});

describe("createWarningCollector", () => {
  it("truncates a message to the schema's per-warning bound", () => {
    const collector = createWarningCollector();
    collector.push("x".repeat(maxWarningLength + 100));
    expect(collector.list()[0]!.length).toBe(maxWarningLength);
  });

  it("stops accepting warnings past the array bound", () => {
    const collector = createWarningCollector();
    for (let i = 0; i < 60; i++) collector.push(`warning ${i}`);
    expect(collector.list()).toHaveLength(50);
  });
});
