import { describe, it, expect } from "vitest";
import {
  renderIngestConfigView,
  parseIngestHealth,
  type IngestHealth,
} from "./ingest-config";

// The ingest config toggle (Thread 15): the sidecar's /health surfaces the live
// extraction + enrichment path; this pure view-model turns it into a
// presentation shape the shell renders as a read-only status + an Isaacus toggle.
// Framework-free and unit-tested, matching the Threads 11-14 posture.

const health = (overrides: Partial<IngestHealth> = {}): IngestHealth => ({
  status: "ok",
  bucket: "redline",
  womblexMode: "stub",
  enrichmentMode: "offline",
  isaacusEnabled: false,
  ...overrides,
});

describe("parseIngestHealth", () => {
  it("narrows a well-formed /health payload", () => {
    const parsed = parseIngestHealth({
      status: "ok",
      bucket: "redline",
      womblexMode: "real",
      enrichmentMode: "isaacus",
      isaacusEnabled: true,
    });
    expect(parsed).toEqual({
      status: "ok",
      bucket: "redline",
      womblexMode: "real",
      enrichmentMode: "isaacus",
      isaacusEnabled: true,
    });
  });

  it("returns null for a payload missing the enrichment fields", () => {
    expect(parseIngestHealth({ status: "ok", bucket: "redline" })).toBeNull();
    expect(parseIngestHealth(null)).toBeNull();
    expect(parseIngestHealth("nope")).toBeNull();
  });
});

describe("renderIngestConfigView", () => {
  it("reports the offline (air-gapped) path when Isaacus is disengaged", () => {
    const view = renderIngestConfigView(health());

    expect(view.extractionModeLabel).toBe("Stub (offline)");
    expect(view.enrichmentLabel).toBe("Offline (air-gapped)");
    expect(view.isaacusToggle.on).toBe(false);
    expect(view.isaacusToggle.label).toBe("Isaacus enrichment");
    expect(view.airGapped).toBe(true);
  });

  it("reports the Isaacus path when it is engaged", () => {
    const view = renderIngestConfigView(
      health({ womblexMode: "real", enrichmentMode: "isaacus", isaacusEnabled: true }),
    );

    expect(view.extractionModeLabel).toBe("Real womblex");
    expect(view.enrichmentLabel).toBe("Isaacus");
    expect(view.isaacusToggle.on).toBe(true);
    expect(view.airGapped).toBe(false);
  });

  it("the toggle is only actionable on the real extractor (stub is always offline)", () => {
    const stub = renderIngestConfigView(health({ womblexMode: "stub" }));
    expect(stub.isaacusToggle.disabled).toBe(true);
    expect(stub.isaacusToggle.hint).toContain("real womblex");

    const real = renderIngestConfigView(
      health({ womblexMode: "real", enrichmentMode: "offline", isaacusEnabled: false }),
    );
    expect(real.isaacusToggle.disabled).toBe(false);
  });
});
