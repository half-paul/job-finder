import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractPosting,
  nextPageLink,
  postingLinks,
} from "../../apps/crawler/src/extract";
import { postingArrayPointer } from "../../apps/crawler/src/capture";

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

  it("tier 2: extracts from main tag when no description container exists", () => {
    const posting = extractPosting(
      fixture("tier-2-main.html"),
      new URL("https://acme.example/careers/job/senior-eng-1"),
    );
    expect(posting?.description).toContain("architect scalable systems");
    expect(posting?.description).toContain("distributed systems");
    expect(posting?.description).not.toContain("Home");
  });

  it("tier 3: strips nav/header/footer when no container or main exists", () => {
    const posting = extractPosting(
      fixture("tier-3-no-container.html"),
      new URL("https://acme.example/careers/job/marketing-1"),
    );
    expect(posting?.description).toContain("Lead our marketing team");
    expect(posting?.description).toContain("drive growth initiatives");
    expect(posting?.description).not.toContain("Home");
    expect(posting?.description).not.toContain("Copyright");
  });

  it("handles nested same-tag markup within description container", () => {
    const posting = extractPosting(
      fixture("nested-description.html"),
      new URL("https://acme.example/careers/job/pm-1"),
    );
    expect(posting?.description).toContain("Paragraph one");
    expect(posting?.description).toContain("Paragraph two");
    expect(posting?.description).toContain("Paragraph three");
  });
});

describe("posting array detection", () => {
  it("points at a nested array of postings", () => {
    expect(
      postingArrayPointer({
        data: {
          results: [
            { title: "A", url: "/a" },
            { title: "B", url: "/b" },
          ],
        },
      }),
    ).toBe("/data/results");
  });

  it("accepts a top-level array", () => {
    expect(
      postingArrayPointer([
        { name: "A", absolute_url: "https://x.example/a" },
        { name: "B", absolute_url: "https://x.example/b" },
      ]),
    ).toBe("");
  });

  it("rejects an array of one, and arrays without a title and a URL", () => {
    expect(
      postingArrayPointer({ results: [{ title: "A", url: "/a" }] }),
    ).toBeNull();
    expect(
      postingArrayPointer({ results: [{ colour: "red" }, { colour: "blue" }] }),
    ).toBeNull();
  });
});
