import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  canonicalUrl,
} from "../../apps/web/lib/security";
import { verifyOrigin, readBody } from "../../apps/web/lib/http";
describe("credential and request boundaries", () => {
  it("salts passwords and rejects wrong passwords and malformed hashes", async () => {
    const first = await hashPassword("a long test password");
    const second = await hashPassword("a long test password");
    expect(first).not.toBe(second);
    expect(await verifyPassword("a long test password", first)).toBe(true);
    expect(await verifyPassword("wrong password", first)).toBe(false);
    expect(await verifyPassword("a long test password", "broken")).toBe(false);
  });
  it("requires exact origin on mutations", () => {
    process.env.APP_ORIGIN = "http://localhost:3000";
    expect(() =>
      verifyOrigin(
        new Request("http://localhost:3000/api/profile", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow();
    expect(() =>
      verifyOrigin(new Request("http://localhost:3000/api/profile")),
    ).toThrow();
    expect(() =>
      verifyOrigin(
        new Request("http://localhost:3000/api/profile", {
          headers: { origin: "http://localhost:3000" },
        }),
      ),
    ).not.toThrow();
  });
  it("bounds bodies even without a content-length header", async () => {
    await expect(
      readBody(
        new Request("http://localhost", { method: "POST", body: "123456" }),
        5,
      ),
    ).rejects.toThrow("too large");
  });
  it("removes tracking while preserving job identity query parameters", () => {
    expect(
      canonicalUrl("https://example.com/job?id=123&utm_source=test#apply"),
    ).toBe("https://example.com/job?id=123");
    expect(canonicalUrl("https://example.com/job?id=456")).not.toBe(
      canonicalUrl("https://example.com/job?id=123"),
    );
  });
});
