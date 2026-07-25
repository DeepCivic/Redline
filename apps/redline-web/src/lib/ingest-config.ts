// Ingest configuration toggle (Thread 15). The womblex-ingest sidecar's /health
// surfaces the live extraction path (stub vs real womblex) and whether Isaacus
// enrichment is engaged or the sidecar is running fully offline (air-gapped).
// This is a pure view-model the Next.js/React shell binds to as a read-only
// status panel plus an Isaacus on/off toggle, matching the framework-free,
// unit-tested posture of the Threads 11-14 UI cores (ADR-0006).
//
// Isaacus is doubly opt-in (build plan §7 Track 5): the real womblex image *and*
// a runtime key. The stub path is always offline, so the toggle is only
// actionable once the real extractor is live — the view surfaces that constraint
// rather than letting the shell offer a toggle that can't take effect.

export type WomblexMode = "stub" | "real";
export type EnrichmentMode = "offline" | "isaacus";

export interface IngestHealth {
  readonly status: string;
  readonly bucket: string;
  readonly womblexMode: WomblexMode;
  readonly enrichmentMode: EnrichmentMode;
  readonly isaacusEnabled: boolean;
}

export interface IsaacusToggleView {
  readonly label: string;
  readonly on: boolean;
  readonly disabled: boolean;
  readonly hint: string;
}

export interface IngestConfigView {
  readonly online: boolean;
  readonly extractionModeLabel: string;
  readonly enrichmentLabel: string;
  readonly airGapped: boolean;
  readonly isaacusToggle: IsaacusToggleView;
}

// Narrows the untrusted /health JSON into a typed IngestHealth, or null when the
// enrichment fields are absent (an older sidecar or a malformed response). The
// shell treats null as "config unavailable" rather than crashing.
export const parseIngestHealth = (payload: unknown): IngestHealth | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const womblexMode = record.womblexMode;
  const enrichmentMode = record.enrichmentMode;
  if (womblexMode !== "stub" && womblexMode !== "real") return null;
  if (enrichmentMode !== "offline" && enrichmentMode !== "isaacus") return null;
  if (typeof record.isaacusEnabled !== "boolean") return null;
  if (typeof record.status !== "string" || typeof record.bucket !== "string") return null;

  return {
    status: record.status,
    bucket: record.bucket,
    womblexMode,
    enrichmentMode,
    isaacusEnabled: record.isaacusEnabled,
  };
};

const EXTRACTION_LABELS: Record<WomblexMode, string> = {
  stub: "Stub (offline)",
  real: "Real womblex",
};

const ENRICHMENT_LABELS: Record<EnrichmentMode, string> = {
  offline: "Offline (air-gapped)",
  isaacus: "Isaacus",
};

export const renderIngestConfigView = (health: IngestHealth): IngestConfigView => {
  const isReal = health.womblexMode === "real";
  return {
    online: health.status === "ok",
    extractionModeLabel: EXTRACTION_LABELS[health.womblexMode],
    enrichmentLabel: ENRICHMENT_LABELS[health.enrichmentMode],
    airGapped: health.enrichmentMode === "offline",
    isaacusToggle: {
      label: "Isaacus enrichment",
      on: health.isaacusEnabled,
      disabled: !isReal,
      hint: isReal
        ? "Requires an Isaacus API key at runtime."
        : "Only available on the real womblex extractor; the stub path is always offline.",
    },
  };
};
