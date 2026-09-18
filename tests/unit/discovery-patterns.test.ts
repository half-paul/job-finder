// tests/unit/discovery-patterns.test.ts
import { describe, expect, it } from "vitest";
import {
  buildPatternSpec,
  inferFieldMap,
  renderTemplate,
  validatePattern,
} from "../../packages/discovery/src/patterns";
import type { CapturedRequest } from "@jobfinder/shared";

const routeFetch = (routes: Record<string, () => Response>) =>
  (async (input: RequestInfo | URL) => {
    const key = String(input instanceof Request ? input.url : input);
    return routes[key]?.() ?? new Response("missing", { status: 404 });
  }) as typeof fetch;

describe("Phase 5 captured-pattern field inference", () => {
  it("maps recognizable fields including a nested location, and requires title and url", () => {
    const sample = [
      {
        jobTitle: "Engineer",
        absoluteUrl: "https://acme.example/jobs/1",
        reqId: "42",
        location: { city: "Remote" },
        jobDescription: "Build things.",
        datePosted: "2026-09-01",
        unrelated: true,
      },
    ];
    expect(inferFieldMap(sample)).toEqual({
      title: "/jobTitle",
      url: "/absoluteUrl",
      id: "/reqId",
      location: "/location/city",
      description: "/jobDescription",
      postedAt: "/datePosted",
    });
    expect(inferFieldMap([{ jobTitle: "Engineer only" }])).toBeNull();
    expect(inferFieldMap([])).toBeNull();
  });

  it("ignores a nested location object without a name-like inner key", () => {
    expect(
      inferFieldMap([
        {
          title: "Engineer",
          url: "https://x/1",
          location: { unrelated: "value" },
        },
      ])?.location,
    ).toBeUndefined();
  });
});

describe("Phase 5 captured-pattern spec builder", () => {
  const base: CapturedRequest = {
    url: "https://acme.example/api/jobs?page=1",
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: "session=secret",
      authorization: "Bearer token",
    },
    body: null,
    jobsPath: "/jobs",
    sample: [{ title: "Engineer", url: "https://acme.example/jobs/1" }],
  };

  it("rewrites a numeric page query parameter and keeps only allowlisted headers", () => {
    const spec = buildPatternSpec(base);
    expect(spec).toMatchObject({
      urlTemplate: "https://acme.example/api/jobs?page=%7Bpage%7D",
      headers: { accept: "application/json" },
    });
    expect(spec?.headers).not.toHaveProperty("cookie");
    expect(spec?.headers).not.toHaveProperty("authorization");
  });

  it("rewrites a numeric page field inside a JSON POST body when the URL has none", () => {
    const spec = buildPatternSpec({
      ...base,
      url: "https://acme.example/api/jobs",
      method: "POST",
      body: JSON.stringify({ pageNumber: 1, size: 50 }),
    });
    expect(spec?.urlTemplate).toBe("https://acme.example/api/jobs");
    expect(JSON.parse(spec!.body!)).toEqual({ pageNumber: "{page}", size: 50 });
  });

  it("returns null when no sample is captured or no field map can be inferred", () => {
    expect(buildPatternSpec({ ...base, sample: [] })).toBeNull();
    expect(
      buildPatternSpec({ ...base, sample: [{ nothingUseful: true }] }),
    ).toBeNull();
  });
});

describe("Phase 5 captured-pattern template rendering", () => {
  it("replaces every {page} placeholder with the given page number", () => {
    expect(
      renderTemplate("https://acme.example/api?page={page}&p={page}", 3),
    ).toBe("https://acme.example/api?page=3&p=3");
    expect(renderTemplate("https://acme.example/api", 2)).toBe(
      "https://acme.example/api",
    );
  });
});

describe("Phase 5 captured-pattern validation replay", () => {
  const spec = {
    urlTemplate: "https://acme.example/api/jobs?page={page}",
    method: "GET" as const,
    headers: {},
    body: null,
    jobsPath: "/jobs",
    fieldMap: { title: "/title", url: "/url" },
  };

  it("fails a not-modified replay with its HTTP status instead of throwing", async () => {
    await expect(
      validatePattern(spec, {
        fetchImpl: (async () =>
          new Response(null, { status: 304 })) as typeof fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "HTTP 304" });
  });

  it("counts postings when the replayed response matches the field map", async () => {
    const fetchImpl = routeFetch({
      "https://acme.example/api/jobs?page=1": () =>
        Response.json({
          jobs: [
            { title: "Engineer", url: "https://acme.example/jobs/1" },
            { title: "Designer", url: "https://acme.example/jobs/2" },
          ],
        }),
    });
    await expect(validatePattern(spec, { fetchImpl })).resolves.toEqual({
      ok: true,
      count: 2,
    });
  });

  it("reports a clear reason when the pointer, the array or a mapped field is missing", async () => {
    const notArray = routeFetch({
      "https://acme.example/api/jobs?page=1": () =>
        Response.json({ jobs: { not: "an array" } }),
    });
    await expect(
      validatePattern(spec, { fetchImpl: notArray }),
    ).resolves.toEqual({
      ok: false,
      reason: "No postings at jobsPath",
    });

    const empty = routeFetch({
      "https://acme.example/api/jobs?page=1": () => Response.json({ jobs: [] }),
    });
    await expect(validatePattern(spec, { fetchImpl: empty })).resolves.toEqual({
      ok: false,
      reason: "Replay returned no postings",
    });

    const missingField = routeFetch({
      "https://acme.example/api/jobs?page=1": () =>
        Response.json({ jobs: [{ title: "Engineer" }] }),
    });
    await expect(
      validatePattern(spec, { fetchImpl: missingField }),
    ).resolves.toEqual({
      ok: false,
      reason: "Cannot resolve field url",
    });
  });
});
