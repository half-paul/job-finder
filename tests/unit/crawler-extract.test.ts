import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractPosting,
  nextPageLink,
  postingLinks,
} from "../../apps/crawler/src/extract";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/crawler/${name}`, import.meta.url), "utf8");

describe("crawler extraction", () => {
  const base = new URL("https://acme.example/careers");

  it("keeps posting links and drops navigation and third-party links", () => {
    expect(
      postingLinks(fixture("listing.html"), base).map((u) => u.href),
    ).toEqual([
      "https://acme.example/careers/job/staff-engineer-1234",
      "https://acme.example/careers/job/designer-5678",
    ]);
  });

  it("finds a rel=next pagination link", () => {
    expect(nextPageLink(fixture("listing.html"), base)?.href).toBe(
      "https://acme.example/careers?page=2",
    );
  });

  it("returns null when pagination is a script-driven button", () => {
    expect(nextPageLink(fixture("paginated.html"), base)).toBeNull();
  });

  it("reads a posting from the DOM when there is no JSON-LD", () => {
    const posting = extractPosting(
      fixture("posting.html"),
      new URL("https://acme.example/careers/job/staff-engineer-1234"),
    );
    expect(posting).toMatchObject({
      title: "Staff Engineer",
      location: "Vancouver, BC",
    });
    expect(posting?.description).toContain("build the thing");
  });

  it("prefers JSON-LD over the DOM", () => {
    const html = `<html><body><h1>Wrong title</h1><script type="application/ld+json">
      {"@type":"JobPosting","title":"Right Title","description":"A real description of the role.",
       "datePosted":"2026-09-01","jobLocation":{"address":{"addressLocality":"Remote"}},"url":"https://acme.example/careers/job/x-1"}
    </script></body></html>`;
    expect(
      extractPosting(html, new URL("https://acme.example/careers/job/x-1")),
    ).toMatchObject({ title: "Right Title", postedAt: "2026-09-01" });
  });

  it("extracts description from a dedicated container and excludes nav", () => {
    const posting = extractPosting(
      fixture("with-nav.html"),
      new URL("https://acme.example/careers/job/senior-dev-1"),
    );
    expect(posting?.description).toContain("Build amazing systems");
    expect(posting?.description).toContain("own the full lifecycle");
    expect(posting?.description).not.toContain("Home");
    expect(posting?.description).not.toContain("Careers");
  });

  it("decodes HTML entities in descriptions", () => {
    const html = `<html><body><h1>Job Title</h1><div class="description">
      You&apos;ll build tools &amp; systems. We&apos;re looking for a team player.
    </div></body></html>`;
    const posting = extractPosting(
      html,
      new URL("https://acme.example/careers/job/x-1"),
    );
    expect(posting?.description).toContain("You'll build");
    expect(posting?.description).toContain("tools & systems");
    expect(posting?.description).not.toContain("&apos;");
    expect(posting?.description).not.toContain("&amp;");
  });
});
