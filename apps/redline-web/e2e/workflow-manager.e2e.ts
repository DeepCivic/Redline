import { test, expect } from "@playwright/test";

// Thread 11 exit test (UI) — the specialist can compose the three relationship
// shapes and advance the stage. This Playwright spec is the acceptance artifact
// for the control surface once the SvelteKit shell is served (see the app
// README's "Running the e2e" note). In the current environment there is no
// browser/app server, so the executable exit test is the vitest suite that
// exercises the same WorkflowManager + WorkflowController the DOM binds to —
// documented as a deliberate deviation in .claude/CLAUDE.md.

test.describe("specialist control surface", () => {
  test("shape 1 — one vendor, many docs, one response", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/grouping");
    await page.getByRole("button", { name: "Add vendor" }).click();
    await page.getByLabel("Vendor name").fill("Acme");
    await page.getByRole("button", { name: "Save vendor" }).click();

    await page.getByRole("button", { name: "New response group" }).click();
    await page.getByLabel("Group label").fill("Acme — Core Bid");
    await page.getByRole("button", { name: "Create group" }).click();

    await page.getByTestId("doc-doc-1").dragTo(page.getByTestId("group-drop-g-acme"));
    await page.getByTestId("doc-doc-2").dragTo(page.getByTestId("group-drop-g-acme"));

    await expect(page.getByTestId("group-g-acme-count")).toHaveText("2 documents");
    await expect(page.getByTestId("group-g-acme-consortium")).toHaveCount(0);
  });

  test("shape 2 — many vendors, one consortium response", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/grouping");
    await page.getByRole("button", { name: "Mark consortium" }).click();
    await page.getByLabel("Members").selectOption(["v-a", "v-b"]);
    await page.getByRole("button", { name: "Confirm consortium" }).click();

    await expect(page.getByTestId("group-g-jv-consortium")).toBeVisible();
  });

  test("shape 3 — one vendor, many responses, then advance", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/grouping");
    await expect(page.getByTestId("group-g-core")).toBeVisible();
    await expect(page.getByTestId("group-g-premium")).toBeVisible();

    await page.getByRole("button", { name: /Advance to Classifying/ }).click();
    await expect(page.getByTestId("stage-label")).toHaveText("Classifying");
  });
});
