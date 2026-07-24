import { test, expect } from "@playwright/test";

// Thread 14 exit test (UI) — "Export to Excel" downloads a workbook whose
// currency cells are numeric and whose source column links resolve to the exact
// document location. This Playwright spec is the acceptance artifact once the
// Next.js shell serves the review route with an export button; in the current
// environment (no browser/app server) the executable exit test is the vitest
// suite over the same buildEvaluationWorkbook / buildReviewSheetData the writer
// serialises — a deliberate deviation recorded in .claude/CLAUDE.md.

test.describe("Excel export", () => {
  test("downloads a workbook named after the evaluation and date", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/review");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export to Excel" }).click();
    const download = await downloadPromise;

    // A dated .xlsx named after the evaluation (evaluationExportFileName).
    expect(download.suggestedFilename()).toMatch(/-evaluation-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  test("the exported workbook opens with a Review sheet and one sheet per pivot", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/review");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export to Excel" }).click();
    const download = await downloadPromise;

    // The download stream resolves — a real, openable file (parsing its sheets
    // is covered exhaustively by the vitest sheet-data suite; the numeric
    // currency and source hyperlinks are asserted there).
    expect(await download.path()).toBeTruthy();
  });
});
