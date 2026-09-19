import { test, expect } from "@playwright/test";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawlMaxJobs, crawlMaxPages } from "@jobfinder/shared";

const crawlerUrl = process.env.CRAWLER_URL ?? "http://localhost:4000";
const secret = process.env.CRAWLER_SECRET ?? "local-development-only";
const auth = {
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
};

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/crawler/${name}`, import.meta.url), "utf8");

/** Self-signed cert for a throwaway HTTPS origin the crawler can reach. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "crawler-e2e-"));
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,DNS:host.docker.internal",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ]);
  return {
    key: readFileSync(join(dir, "key.pem")),
    cert: readFileSync(join(dir, "cert.pem")),
  };
}

const routes: Record<string, { body: string; type?: string }> = {
  "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
  "/careers": { body: fixture("listing.html") },
  "/careers?page=2": {
    body: "<html><body><a href='/careers/job/third-9012'>Third</a></body></html>",
  },
  "/careers/job/staff-engineer-1234": { body: fixture("posting.html") },
  "/careers/job/designer-5678": { body: fixture("posting.html") },
  "/careers/job/third-9012": { body: fixture("posting.html") },
  "/challenge": {
    body: '<html><body><div class="g-recaptcha"></div></body></html>',
  },
  // A page whose listings come from its own JSON API rather than server-
  // rendered HTML — the shape `/capture` exists to observe. The cookie is
  // set client-side so the browser attaches it to the fetch itself (a
  // script cannot set a `Cookie:` header directly); the `Authorization`
  // header is set explicitly. Both must be gone from the saved pattern.
  "/capture-source": {
    body: `<html><body><script>
      document.cookie = "session=super-secret";
      fetch("/api/jobs", {
        headers: {
          "Authorization": "Bearer super-secret-token",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
    </script></body></html>`,
  },
  "/api/jobs": {
    body: JSON.stringify({
      data: {
        results: [
          { title: "Staff Engineer", url: "/careers/job/staff-engineer-1234" },
          { title: "Designer", url: "/careers/job/designer-5678" },
        ],
      },
    }),
    type: "application/json",
  },
};

test.describe("crawler service", () => {
  let origin = "";
  let server: ReturnType<typeof createServer>;

  test.beforeAll(async () => {
    server = createServer(certificate(), (req, res) => {
      const route = routes[req.url ?? ""];
      if (!route) {
        res.writeHead(404).end("missing");
        return;
      }
      res.writeHead(200, { "content-type": route.type ?? "text/html" });
      res.end(route.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No port");
    origin = `https://host.docker.internal:${address.port}`;
  });

  test.afterAll(() => server.close());

  // M2 fix round: a stray process squatting on CRAWLER_URL's port answered
  // every request in this suite during earlier development, with none of
  // the crawler's own logs to show for it, and every test below still
  // "passed" against a service that was not the crawler at all. This check
  // runs first and unauthenticated, so a wrong CRAWLER_URL fails loudly and
  // immediately with a named cause, instead of quietly producing a false
  // green for the tests that follow.
  test("CRAWLER_URL answers as the crawler, not some other service", async ({
    request,
  }) => {
    const response = await request.get(`${crawlerUrl}/health`);
    expect(response.ok(), await response.text()).toBe(true);
    expect(await response.json()).toMatchObject({
      service: "jobfinder-crawler",
      status: "ok",
    });
  });

  test("rejects an unauthenticated request", async ({ request }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: { "content-type": "application/json" },
      data: { url: `${origin}/careers` },
    });
    expect(response.status()).toBe(401);
  });

  test("crawls a listing, follows rel=next and returns postings", async ({
    request,
  }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: auth,
      data: {
        url: `${origin}/careers`,
        maxPages: crawlMaxPages,
        maxJobs: crawlMaxJobs,
      },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.jobs.length).toBeGreaterThanOrEqual(3);
    expect(body.jobs[0]).toMatchObject({
      title: "Staff Engineer",
      location: "Vancouver, BC",
    });
    expect(body.complete).toBe(true);
  });

  test("reports an incomplete walk when the page cap is hit", async ({
    request,
  }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: auth,
      data: { url: `${origin}/careers`, maxPages: 1, maxJobs: crawlMaxJobs },
    });
    expect((await response.json()).complete).toBe(false);
  });

  test("ends the session on a challenge page without retrying", async ({
    request,
  }) => {
    const response = await request.post(`${crawlerUrl}/crawl`, {
      headers: auth,
      data: {
        url: `${origin}/challenge`,
        maxPages: crawlMaxPages,
        maxJobs: crawlMaxJobs,
      },
    });
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({ kind: "captcha" });
  });

  test("captures the JSON API a page calls, with headers reduced to the allowlist", async ({
    request,
  }) => {
    const response = await request.post(`${crawlerUrl}/capture`, {
      headers: auth,
      data: { url: `${origin}/capture-source` },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.patterns).toHaveLength(1);
    const [pattern] = body.patterns;
    expect(pattern.url).toContain("/api/jobs");
    expect(pattern.method).toBe("GET");
    expect(pattern.jobsPath).toBe("/data/results");
    expect(pattern.sample).toHaveLength(2);
    // The whole point of the allowlist: neither the cookie the page set nor
    // the authorization header it sent survives into the saved pattern.
    expect(Object.keys(pattern.headers)).not.toContain("cookie");
    expect(Object.keys(pattern.headers)).not.toContain("authorization");
    expect(pattern.headers["x-requested-with"]).toBe("XMLHttpRequest");
  });
});
