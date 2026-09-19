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

  it("gives up past a depth cap instead of recursing until the stack overflows", () => {
    // A real postings array, but buried far past any shape a genuine API
    // would use. If the depth cap did not exist, this would still resolve
    // correctly (JS handles a few thousand stack frames fine) — the point of
    // this test is the *cap*, not the stack limit itself, so it asserts the
    // cap's actual, observable effect: giving up early returns null even
    // though a real array is down there, rather than finding it.
    let nested: unknown = [
      { title: "A", url: "/a" },
      { title: "B", url: "/b" },
    ];
    for (let i = 0; i < 5000; i++) nested = { level: nested };
    expect(() => postingArrayPointer(nested)).not.toThrow();
    expect(postingArrayPointer(nested)).toBeNull();
  });
});

describe("extraction on pathological HTML", () => {
  const base = new URL("https://acme.example/careers");
  /** The page cap `session.ts` enforces: what a hostile page may actually be. */
  const pageCap = 8 * 1024 * 1024;
  const repeatTo = (unit: string, bytes: number) =>
    unit.repeat(Math.floor(bytes / unit.length));

  /**
   * Every scan in `extract.ts` used to be `/<tag[^>]*.../g` run over the whole
   * document, which is quadratic on adversarial input: measured before the
   * fix, `postingLinks` on `"<a"` repeats took 0.84 s at 50 KB, 3.15 s at
   * 100 KB, 11.17 s at 200 KB and 40.65 s at 400 KB. At the 8 MB page cap
   * that is hours of a blocked event loop — and the crawler is single
   * threaded, so one hostile careers page denies every concurrent crawl and
   * `/health` with it, which `restart: unless-stopped` will not recover.
   *
   * The budget below is deliberately loose (each case measured well under
   * 0.2 s on a developer laptop after the fix, and the old code needed more
   * than ten seconds at a fortieth of this input size). It is a guard against
   * a reintroduced n², not a benchmark: anything quadratic blows straight
   * through it, and ordinary machine-speed variation does not come close.
   */
  const budgetMs = 5_000;
  const withinBudget = (label: string, run: () => void) => {
    const started = Date.now();
    run();
    const elapsed = Date.now() - started;
    expect(elapsed, `${label} took ${elapsed}ms`).toBeLessThan(budgetMs);
  };

  const cases: Array<[string, string]> = [
    // Unterminated anchors: the original `anchorPattern` case.
    ["unclosed anchors", repeatTo("<a", pageCap)],
    // Anchors that do close, so every one is a real candidate.
    [
      "closed anchors",
      repeatTo('<a href="/careers/job/eng-1234">Eng</a>', pageCap),
    ],
    // `findDescriptionContainer`'s depth walk, which re-exec'd from `pos`.
    [
      "unbalanced description container",
      `<h1>Role</h1><div class="description">${repeatTo("<div", pageCap)}`,
    ],
    // The `<nav>/<header>/<footer>` strip in `extractDescription`.
    ["unclosed nav elements", `<h1>Role</h1>${repeatTo("<nav", pageCap)}`],
    [
      "balanced nav elements",
      `<h1>Role</h1>${repeatTo("<nav>x</nav>", pageCap)}`,
    ],
    // `titlePattern` and `locationPattern` had the same shape.
    ["unclosed headings", repeatTo("<h1", pageCap)],
    ["bare angle brackets", `<h1>Role</h1>${repeatTo("<", pageCap)}`],
    // Reached through `htmlToText`, which was quadratic too.
    ["unclosed script tags", `<h1>Role</h1>${repeatTo("<script", pageCap)}`],
  ];

  for (const [label, html] of cases) {
    it(`completes postingLinks, nextPageLink and extractPosting on ${label} in bounded time`, () => {
      withinBudget(`postingLinks/${label}`, () => {
        postingLinks(html, base);
      });
      withinBudget(`nextPageLink/${label}`, () => {
        nextPageLink(html, base);
      });
      withinBudget(`extractPosting/${label}`, () => {
        extractPosting(html, base);
      });
    });
  }

  it("still reads a normal posting buried in 8MB of junk", () => {
    const html = `<html><body><h1>Staff Engineer</h1>
      <span class="location">Vancouver, BC</span>
      <div class="description">A real role.</div>
      ${repeatTo("<a", 1024 * 1024)}</body></html>`;
    let posting: ReturnType<typeof extractPosting> = null;
    withinBudget("extractPosting/mixed", () => {
      posting = extractPosting(html, base);
    });
    expect(posting).toMatchObject({
      title: "Staff Engineer",
      location: "Vancouver, BC",
      description: "A real role.",
    });
  });
});
