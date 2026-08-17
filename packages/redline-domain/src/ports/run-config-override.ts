import type { Result } from "../result";

// Per-corpus overrides applied on top of womblex's own YAML run config
// (services/womblex/configs/*.yaml — dataset.*, extraction.*, chunking.*, …)
// before triggering a run. Opaque dot-path key/value pairs, not a typed
// mirror of womblex's config: that schema is womblex's to evolve, and
// redline forking it into its own types would duplicate what the library
// already validates (womblex's own "thin adapter" convention).

export interface RunConfigOverride {
  readonly key: string; // dot path, e.g. "extraction.ocr.engine"
  readonly value: string;
}

export interface IRunConfigOverride {
  read(corpusId: string): Promise<Result<readonly RunConfigOverride[]>>;
  write(corpusId: string, overrides: readonly RunConfigOverride[]): Promise<Result<void>>;
}
