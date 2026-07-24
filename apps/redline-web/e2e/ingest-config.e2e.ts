import { test, expect } from "@playwright/test";

// Thread 15 exit test (UI) — the ingest configuration toggle surfaces whether
// the womblex sidecar is running the air-gapped (offline) path or engaging
// Isaacus enrichment, and lets the specialist toggle Isaacus when the real
// extractor is live. This Playwright spec is the acceptance artifact once the
// Next.js shell serves the settings/ingest route; in the current environment
// (no browser/app server) the executable exit test is the vitest suite over the
// same renderIngestConfigView / parseIngestHealth the panel binds to — a
// deliberate deviation recorded in .claude/CLAUDE.md. The pipeline-level exit
// criterion (full pipeline runs with ISAACUS_API_KEY unset) is proven by the
// womblex-ingest pytest suite + scripts/thread-15-airgap.sh.

test.describe("Ingest configuration toggle", () => {
  test("shows the offline (air-gapped) enrichment path by default", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e/settings/ingest");

    await expect(page.getByText("Offline (air-gapped)")).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Isaacus enrichment" });
    await expect(toggle).not.toBeChecked();
    // The stub path is always offline, so the toggle is disabled.
    await expect(toggle).toBeDisabled();
  });

  test("reports Isaacus engaged when the real extractor has a key", async ({ page }) => {
    await page.goto("/evaluations/eval-e2e-isaacus/settings/ingest");

    await expect(page.getByText("Isaacus")).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Isaacus enrichment" });
    await expect(toggle).toBeChecked();
  });
});
