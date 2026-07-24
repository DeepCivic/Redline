import { test, expect } from "@playwright/test";

// Thread 13 exit test (UI) — the pricing pivots roll a real evaluation's
// responses up per brand and per requirement, with a brand × requirement
// cross-tab and a sum/average toggle. This Playwright spec is the acceptance
// artifact once the Next.js shell serves the route; in the current environment
// (no browser/app server) the executable exit test is the vitest suite over the
// same PricingPivot + renderPivotView the DOM binds to — a deliberate deviation
// recorded in .claude/CLAUDE.md.

test.describe("pricing pivots", () => {
  test("rolls pricing up per brand (vendor)", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/pivots");

    await page.getByLabel("Axis").selectOption("brand");
    const pivot = page.getByTestId("pricing-pivot");
    await expect(pivot).toBeVisible();
    await expect(pivot.getByRole("columnheader", { name: "Vendor" })).toBeVisible();
    await expect(pivot.getByRole("columnheader", { name: "Total (AUD)" })).toBeVisible();
  });

  test("rolls pricing up per requirement/criterion", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/pivots");

    await page.getByLabel("Axis").selectOption("requirement");
    await expect(
      page.getByTestId("pricing-pivot").getByRole("columnheader", { name: "Requirement" }),
    ).toBeVisible();
  });

  test("cross-tabulates brand × requirement", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/pivots");

    await page.getByLabel("Axis").selectOption("brand-x-requirement");
    const headers = await page.getByTestId("pricing-pivot").getByRole("columnheader").allInnerTexts();
    // Vendor + one column per requirement + a row-total column.
    expect(headers.length).toBeGreaterThan(2);
  });

  test("toggles between sum and average", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/pivots");

    await page.getByLabel("Measure").selectOption("avg");
    await expect(
      page.getByTestId("pricing-pivot").getByRole("columnheader", { name: "Average (AUD)" }),
    ).toBeVisible();
  });
});
