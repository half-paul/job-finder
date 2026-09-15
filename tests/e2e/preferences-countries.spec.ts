import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("preferences persist selected countries and the evaluation batch limit", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill("Country preference tester");
  await page
    .getByLabel("Email address")
    .fill(`prefs-${randomUUID()}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("A test-only passphrase 2026!");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next move, in focus." }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Preferences", exact: true }).click();
  // Both sections offer Unknown so postings that omit the value can be
  // explicitly accepted and are always evaluated.
  const workArrangement = page.getByRole("group", { name: "Work arrangement" });
  const seniority = page.getByRole("group", { name: "Seniority" });
  await expect(
    workArrangement.getByRole("checkbox", { name: "Unknown", exact: true }),
  ).toBeVisible();
  await expect(
    seniority.getByRole("checkbox", { name: "Unknown", exact: true }),
  ).toBeVisible();
  await workArrangement
    .getByRole("checkbox", { name: "Unknown", exact: true })
    .check();
  await seniority
    .getByRole("checkbox", { name: "Unknown", exact: true })
    .check();
  await page.getByLabel("Add a country").selectOption("CA");
  await page.getByRole("button", { name: "Add country", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove Canada", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Work arrangement" })
      .getByRole("checkbox", { name: "Unknown", exact: true }),
  ).toBeChecked();
  await expect(
    page
      .getByRole("group", { name: "Seniority" })
      .getByRole("checkbox", { name: "Unknown", exact: true }),
  ).toBeChecked();
  // No country selected means all countries; worldwide jobs can be excluded.
  await page.getByLabel("Include jobs available worldwide").uncheck();
  await page.getByLabel("Include jobs with unknown countries").check();
  await page
    .getByLabel("Required keywords for importing")
    .fill("platform engineering, kubernetes");
  await page
    .getByLabel("Keywords that block importing")
    .fill("commission only");
  await page.getByLabel("Jobs to evaluate per sync").fill("3");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Preferences saved.");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Remove Canada", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Jobs to evaluate per sync")).toHaveValue("3");
  await expect(
    page.getByLabel("Include jobs available worldwide"),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Include jobs with unknown countries"),
  ).toBeChecked();
  await expect(page.getByLabel("Required keywords for importing")).toHaveValue(
    "platform engineering, kubernetes",
  );
  await expect(page.getByLabel("Keywords that block importing")).toHaveValue(
    "commission only",
  );
  const stored = await (await page.request.get("/api/preferences")).json();
  expect(stored.includeKeywords).toEqual([
    "platform engineering",
    "kubernetes",
  ]);
  expect(stored.negativeKeywords).toEqual(["commission only"]);
  await page.screenshot({
    path: "test-results/preferences-countries-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.getElementById("root") === null,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/preferences-countries-mobile.png",
    fullPage: true,
  });
});
