import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
const password = "A test-only passphrase 2026!";
test("private workspace persists profile, resume, preferences and job progress", async ({
  page,
  browser,
}) => {
  const email = `test-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill("Test Executive");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next move, in focus." }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Career profile", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Current role", { exact: true })
    .fill("VP Infrastructure");
  await page
    .getByLabel("Skills & expertise")
    .fill("AWS, Security, AI governance");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toHaveText("Profile saved.");
  await page.reload();
  await expect(page.getByLabel("Current role", { exact: true })).toHaveValue(
    "VP Infrastructure",
  );
  await page.getByLabel("Resume file").setInputFiles({
    name: "resume.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Test executive with cloud architecture, AWS and security leadership experience.",
    ),
  });
  await page
    .getByRole("button", { name: "Upload resume", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Extracted text" }),
  ).toBeVisible();
  const files = await (await page.request.get("/api/resumes")).json();
  expect(files).toHaveLength(1);
  const other = await browser.newContext({ baseURL: "http://localhost:3000" });
  const otherPage = await other.newPage();
  await otherPage.goto("/login");
  expect(
    (await other.request.get(`/api/resumes/${files[0].id}`)).status(),
  ).toBe(401);
  const origin = { Origin: "http://localhost:3000" };
  expect(
    (
      await other.request.post("/api/auth/register", {
        headers: origin,
        data: {
          email: `other-${randomUUID()}@example.test`,
          password,
          name: "Other account",
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (await other.request.get(`/api/resumes/${files[0].id}`)).status(),
  ).toBe(404);
  expect(
    (
      await page.request.put("/api/profile", {
        headers: { Origin: "https://evil.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("link", { name: "Preferences", exact: true }).click();
  await page.getByRole("button", { name: "Add role", exact: true }).click();
  await page.getByLabel("Target role", { exact: true }).fill("VP AI Platform");
  await page.getByLabel("Role group", { exact: true }).fill("AI leadership");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status")).toHaveText("Preferences saved.");
  await page.goto("/jobs/new");
  await page
    .getByLabel("Job title", { exact: true })
    .fill("VP Platform Engineering");
  await page
    .getByLabel("Company", { exact: true })
    .fill("Example Test Company");
  await page.getByLabel("Location", { exact: true }).fill("Vancouver");
  await page.getByLabel("Work arrangement").selectOption("Remote");
  await page
    .getByLabel("Original listing URL")
    .fill(`https://example.test/careers/${randomUUID()}`);
  await page
    .getByLabel("Job description", { exact: true })
    .fill(
      "Lead the cloud platform, security and infrastructure engineering organization.",
    );
  await page
    .getByRole("button", { name: "Add opportunity", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "VP Platform Engineering", exact: true }),
  ).toBeVisible();
  const jobId = page.url().split("/").pop();
  expect((await other.request.get(`/api/jobs/${jobId}`)).status()).toBe(404);
  expect(
    (
      await other.request.post(`/api/jobs/${jobId}/evaluate`, {
        headers: origin,
      })
    ).status(),
  ).toBe(404);
  await page
    .getByRole("button", { name: "Evaluate match", exact: true })
    .click();
  await expect(
    page.locator(".match-evaluator").getByRole("alert"),
  ).toContainText("Add your current role, summary and skills");
  await page.screenshot({
    path: "test-results/matching-validation-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Your progress").selectOption("Saved");
  await page.getByLabel("Private notes").fill("Review leadership scope.");
  await page.getByRole("button", { name: "Update progress" }).click();
  await expect(page.getByRole("status")).toHaveText("Progress updated.");
  await page.reload();
  await expect(page.getByLabel("Private notes")).toHaveValue(
    "Review leadership scope.",
  );
  await page.getByRole("link", { name: "Saved", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "VP Platform Engineering", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search opportunities").fill("not present");
  await expect(
    page.getByRole("heading", { name: "No opportunities match these filters" }),
  ).toBeVisible();
  await page.goto("/");
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "test-results/dashboard-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/login/);
  expect((await page.request.get("/api/profile")).status()).toBe(401);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your next move, in focus." }),
  ).toBeVisible();
  await other.close();
});
