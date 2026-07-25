import { test, expect } from "@playwright/test";

// Thread 12 exit test (UI) — a real evaluation renders in the sortable review
// grid, currency sorts numerically, and the source column deep-links to the
// document location. This Playwright spec is the acceptance artifact for the
// review grid once the Next.js shell serves the route (see the app README's
// "Running the e2e" note). In the current environment there is no browser/app
// server, so the executable exit test is the vitest suite that exercises the
// same ReviewGrid + renderReviewGridView the DOM binds to — documented as a
// deliberate deviation in .claude/CLAUDE.md.

test.describe("in-app review grid", () => {
  test("renders every required column for a real evaluation", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/review");

    const grid = page.getByTestId("review-grid");
    await expect(grid).toBeVisible();
    for (const label of [
      "Vendor",
      "Product",
      "Requirement",
      "Confidence",
      "Summary",
      "Estimate (AUD)",
      "Costing",
      "Source",
    ]) {
      await expect(grid.getByRole("columnheader", { name: label })).toBeVisible();
    }
  });

  test("sorts currency numerically, not lexically", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/review");

    // Seeded rows: $90, $100, $1,000. A lexical sort would order 100 < 1000 < 90.
    await page.getByRole("columnheader", { name: "Estimate (AUD)" }).click();

    const amounts = await page.getByTestId("cell-estimateAud").allInnerTexts();
    const numeric = amounts.map((text) => Number(text.replace(/[^0-9.]/g, "")));
    const ascending = [...numeric].sort((a, b) => a - b);
    expect(numeric).toEqual(ascending);
  });

  test("the source column deep-links to the document location", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/review");

    const link = page.getByTestId("source-link").first();
    await expect(link).toHaveAttribute("href", /\/evaluations\/eval-e2e\/documents\/.+element=/);
  });

  test("filters the grid to a single requirement", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/review");

    await page.getByLabel("Filter by requirement").selectOption("req-data-residency");
    const requirements = await page.getByTestId("cell-requirementId").allInnerTexts();
    expect(new Set(requirements)).toEqual(new Set(["req-data-residency"]));
  });
});
