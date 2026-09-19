import { describe, expect, it } from "vitest";
import {
  defaultPreferences,
  matchBand,
  nextRunAfter,
  preferencesSchema,
  scanSchedules,
  sourceScheduleSchema,
  watchlistInputSchema,
  watchlistKey,
} from "@jobfinder/shared";
import {
  crawlPatternToSpec,
  digestNotificationKey,
  matchNotificationKey,
} from "@jobfinder/automation";

const at = (iso: string) => new Date(iso);

describe("Phase 4 automation schedules", () => {
  it("aligns every schedule to a UTC boundary strictly after the clock", () => {
    expect(nextRunAfter("Manual", at("2026-09-15T10:20:00Z"))).toBeNull();
    expect(
      nextRunAfter("Hourly", at("2026-09-15T10:20:00Z"))?.toISOString(),
    ).toBe("2026-09-15T11:00:00.000Z");
    expect(
      nextRunAfter("Every 4 hours", at("2026-09-15T10:20:00Z"))?.toISOString(),
    ).toBe("2026-09-15T12:00:00.000Z");
    expect(
      nextRunAfter("Twice daily", at("2026-09-15T13:00:00Z"))?.toISOString(),
    ).toBe("2026-09-16T00:00:00.000Z");
    expect(
      nextRunAfter("Daily", at("2026-09-15T23:30:00Z"))?.toISOString(),
    ).toBe("2026-09-16T00:00:00.000Z");
  });

  it("is strictly after a boundary so Windows repeat instead of stalling", () => {
    const boundary = at("2026-09-15T10:00:00Z");
    const next = nextRunAfter("Hourly", boundary)!;
    expect(next.getTime()).toBeGreaterThan(boundary.getTime());
    expect(next.toISOString()).toBe("2026-09-15T11:00:00.000Z");
    // Re-applying the schedule from the produced instant is stable.
    expect(nextRunAfter("Hourly", next)?.toISOString()).toBe(
      "2026-09-15T12:00:00.000Z",
    );
  });

  it("accepts only known schedules and lists Manual as the default", () => {
    expect(scanSchedules).toContain("Manual");
    expect(sourceScheduleSchema.parse({ schedule: "Hourly" })).toEqual({
      schedule: "Hourly",
    });
    expect(
      sourceScheduleSchema.safeParse({ schedule: "Whenever" }).success,
    ).toBe(false);
  });
});

describe("Phase 4 banding and watchlist contracts", () => {
  it("maps aggregate scores onto the documented recommendation bands", () => {
    expect(matchBand(100)).toBe("Excellent Match");
    expect(matchBand(90)).toBe("Excellent Match");
    expect(matchBand(89)).toBe("Strong Match");
    expect(matchBand(80)).toBe("Strong Match");
    expect(matchBand(79)).toBe("Possible Match");
    expect(matchBand(65)).toBe("Possible Match");
    expect(matchBand(64)).toBe("Stretch Opportunity");
    expect(matchBand(50)).toBe("Stretch Opportunity");
    expect(matchBand(49)).toBe("Weak Match");
    expect(matchBand(1)).toBe("Weak Match");
    expect(matchBand(0)).toBe("Do Not Apply");
  });

  it("normalizes company keys so casing cannot duplicate a watchlist entry", () => {
    expect(watchlistKey("  Example   SaaS ")).toBe("example saas");
    expect(watchlistKey("Example SaaS")).toBe(watchlistKey("example  saas"));
  });

  it("defaults a watchlist entry to a tracked company with no direct scan", () => {
    const parsed = watchlistInputSchema.parse({ company: "Example SaaS" });
    expect(parsed).toMatchObject({
      provider: null,
      board: "",
      priority: "Interesting",
      schedule: "Every 4 hours",
    });
    expect(watchlistInputSchema.safeParse({ company: "" }).success).toBe(false);
    expect(
      watchlistInputSchema.safeParse({
        company: "Example",
        provider: "Workday",
      }).success,
    ).toBe(false);
  });
});

describe("Phase 4 alert and digest contracts", () => {
  it("keeps notification identity per evaluation so replays are idempotent", () => {
    const jobId = "4a7f1c1e-9c0a-4a4b-9c1f-2b0d9e8f7a11";
    const first = matchNotificationKey(jobId, at("2026-09-15T10:00:00Z"), 93);
    expect(first).toBe(
      matchNotificationKey(jobId, at("2026-09-15T10:00:00Z"), 93),
    );
    expect(first).not.toBe(
      matchNotificationKey(jobId, at("2026-09-15T11:00:00Z"), 93),
    );
    expect(first).not.toBe(
      matchNotificationKey(jobId, at("2026-09-15T10:00:00Z"), 94),
    );
    expect(digestNotificationKey(at("2026-09-15T13:05:00Z"))).toBe(
      "digest:2026-09-15:13",
    );
    expect(digestNotificationKey(at("2026-09-15T13:05:00Z"))).not.toBe(
      digestNotificationKey(at("2026-09-15T14:05:00Z")),
    );
  });

  it("parses preferences stored before automation existed", () => {
    const added = new Set([
      "notificationsEnabled",
      "notifyMinScore",
      "digestEnabled",
      "digestMinScore",
      "digestHourUtc",
    ]);
    const legacy = Object.fromEntries(
      Object.entries(defaultPreferences).filter(([key]) => !added.has(key)),
    );
    expect(preferencesSchema.parse(legacy)).toMatchObject({
      notificationsEnabled: true,
      notifyMinScore: 90,
      digestEnabled: false,
      digestMinScore: 85,
      digestHourUtc: 13,
    });
  });

  it("rejects alert and digest thresholds outside their ranges", () => {
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        notifyMinScore: 101,
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        digestMinScore: -1,
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        digestHourUtc: 24,
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...defaultPreferences,
        digestHourUtc: 0,
      }).success,
    ).toBe(true);
  });
});

describe("crawlPatternToSpec", () => {
  const row = {
    id: "00000000-0000-0000-0000-000000000001",
    sourceId: "00000000-0000-0000-0000-000000000002",
    kind: "http-json",
    urlTemplate: "https://acme.example/api/jobs?page={page}",
    method: "GET",
    headers: { accept: "application/json" },
    body: null,
    jobsPath: "/results",
    fieldMap: { title: "/title", url: "/url" },
    discoveredAt: new Date(),
    lastVerifiedAt: null,
    failures: 0,
  };

  it("maps a stored row onto the wire contract", () => {
    expect(crawlPatternToSpec(row)).toEqual({
      urlTemplate: "https://acme.example/api/jobs?page={page}",
      method: "GET",
      headers: { accept: "application/json" },
      body: null,
      jobsPath: "/results",
      fieldMap: { title: "/title", url: "/url" },
    });
  });

  it("returns null for a missing row", () => {
    expect(crawlPatternToSpec(undefined)).toBeNull();
  });

  it("returns null for a row whose stored method is not replayable", () => {
    expect(crawlPatternToSpec({ ...row, method: "DELETE" })).toBeNull();
  });
});
