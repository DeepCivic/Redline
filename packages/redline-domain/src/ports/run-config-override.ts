import { err, ok, type Result } from "../result";
import { domainError } from "../errors/domain-error";

// The allow-listed run-config override — the defined slice of the womblex config
// a Create Corpus form authors (design-principles.md "a defined allow-list — the
// run parameters that plausibly differ as corpus nature changes — not the whole
// config"; delivery-plan §2 item 1). It is deliberately narrow:
//
//   - the stage sequence lives on TriggerRunRequest (it is what a run *is*);
//   - the chunk mode — `chunking.chunking_model` (null for offline token chunking
//     over the vendored Kanon-2 tokeniser vs a set model for AI/semantic
//     chunking), plus `chunk_size` and `chunk_tables`;
//   - the money vocabulary — `extra_header_terms` / `extra_veto_terms` /
//     `default_currency`, corpus-specific by nature (a tender schedule's headers
//     collide with the built-in money terms differently per corpus);
//   - the extraction settings — `extraction.ocr.engine` and `extraction.ocr.dpi`,
//     which decide what a scanned tender's pages become before anything else
//     reads them.
//
// What stays fixed in the file regardless of what a form submits — the embed
// model and task, `enrichment.enabled`, the structural/identity keys — is NOT
// here, and cannot be reached through this shape.
//
// Every group is optional. A blank form field inherits the redline.yaml default
// below the seam, so an absent override group means "run the file as-is" and is
// valid. The constructor keeps a *malformed* override off the wire — a
// non-positive or fractional chunk size, a blank AI model, a blank vocabulary
// term, a non-ISO currency — it does not fill defaults, because the default is
// the file's, not this type's.

export interface ChunkModeOverride {
  // null → offline token chunking (no AI-chunking API call); a set model →
  // AI/semantic chunking. The sidecar's chunk stage refuses the whole pass
  // without a resolvable tokeniser regardless, so null is not "no chunking".
  readonly chunkingModel: string | null;
  readonly chunkSize: number;
  readonly chunkTables: boolean;
}

export interface MoneyVocabularyOverride {
  // Tender-schedule header terms the built-in money set (price, cost, fee, …)
  // misses, and the veto terms that suppress a header colliding with a built-in
  // term while not being money. Whole-token matches, stored lower-cased.
  readonly extraHeaderTerms: readonly string[];
  readonly extraVetoTerms: readonly string[];
  // The currency a bare number inherits when its column/prose declares none
  // (redline.yaml ships AUD). Validated to the three-letter ISO 4217 *shape*
  // here; the sidecar owns membership against the real code table.
  readonly defaultCurrency: string;
}

export interface ExtractionOverride {
  // `redline.yaml` ships `paddleocr` and marks it LOAD-BEARING: reconstructing
  // table cells inside a detected table needs per-detection OCR quads, and only
  // region-based engines supply them, so a VLM engine returns markdown with no
  // regions and silently deletes every table cell on a scanned page — which is
  // where a scanned tender keeps its pricing. Authorable because a first run has
  // nothing to orphan and is the run that meets that corpus. Validated to a
  // non-blank *name* here; the engine owns membership against its own alias
  // table, as the sidecar owns ISO 4217 membership above.
  readonly ocrEngine: string;
  // Render resolution for OCR'd pages. The engine bounds it 72–600 on its own
  // `OCRConfig`; mirrored below so an out-of-range value is refused at the seam
  // rather than raising inside a run that has already started extracting.
  readonly ocrDpi: number;
}

export interface RunConfigOverrideInput {
  readonly chunkMode?: ChunkModeOverride;
  readonly moneyVocabulary?: MoneyVocabularyOverride;
  readonly extraction?: ExtractionOverride;
}

export interface RunConfigOverride {
  // null means the group was not authored — inherit the file. A present group is
  // the validated, normalised override the sidecar merges over the file default.
  readonly chunkMode: ChunkModeOverride | null;
  readonly moneyVocabulary: MoneyVocabularyOverride | null;
  readonly extraction: ExtractionOverride | null;
}

const invalid = (message: string) => err(domainError("VALIDATION_FAILED", message));

const isoCurrency = /^[A-Za-z]{3}$/;

const normaliseTerms = (terms: readonly string[], label: string): Result<string[]> => {
  const normalised: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const trimmed = term.trim().toLowerCase();
    if (trimmed === "") {
      return invalid(`a ${label} term must not be blank`);
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalised.push(trimmed);
  }
  return ok(normalised);
};

const validateChunkMode = (mode: ChunkModeOverride): Result<ChunkModeOverride> => {
  if (!Number.isInteger(mode.chunkSize)) {
    return invalid("chunk size must be a whole number of tokens");
  }
  if (mode.chunkSize <= 0) {
    return invalid("chunk size must be a positive number of tokens");
  }

  if (mode.chunkingModel !== null) {
    const model = mode.chunkingModel.trim();
    if (model === "") {
      return invalid("an AI chunking model must be named, or left null for token chunking");
    }
    return ok({ chunkingModel: model, chunkSize: mode.chunkSize, chunkTables: mode.chunkTables });
  }

  return ok({ chunkingModel: null, chunkSize: mode.chunkSize, chunkTables: mode.chunkTables });
};

const validateMoneyVocabulary = (
  vocabulary: MoneyVocabularyOverride,
): Result<MoneyVocabularyOverride> => {
  const currency = vocabulary.defaultCurrency.trim();
  if (!isoCurrency.test(currency)) {
    return invalid("default currency must be a three-letter code (ISO 4217 shape)");
  }

  const headerTerms = normaliseTerms(vocabulary.extraHeaderTerms, "header");
  if (headerTerms.error) return err(headerTerms.error);

  const vetoTerms = normaliseTerms(vocabulary.extraVetoTerms, "veto");
  if (vetoTerms.error) return err(vetoTerms.error);

  return ok({
    extraHeaderTerms: headerTerms.data,
    extraVetoTerms: vetoTerms.data,
    defaultCurrency: currency.toUpperCase(),
  });
};

// The engine's own bounds on `OCRConfig.dpi`, verified against the pinned
// womblex (0.4.0, d6850de): `Field(default=200, ge=72, le=600)`.
const OCR_DPI_MINIMUM = 72;
const OCR_DPI_MAXIMUM = 600;

const validateExtraction = (extraction: ExtractionOverride): Result<ExtractionOverride> => {
  const engine = extraction.ocrEngine.trim().toLowerCase();
  if (engine === "") {
    return invalid("an OCR engine must be named, or the extraction group left out");
  }
  if (!Number.isInteger(extraction.ocrDpi)) {
    return invalid("OCR dpi must be a whole number");
  }
  if (extraction.ocrDpi < OCR_DPI_MINIMUM || extraction.ocrDpi > OCR_DPI_MAXIMUM) {
    return invalid(`OCR dpi must be between ${OCR_DPI_MINIMUM} and ${OCR_DPI_MAXIMUM}`);
  }
  return ok({ ocrEngine: engine, ocrDpi: extraction.ocrDpi });
};

export const makeRunConfigOverride = (
  input: RunConfigOverrideInput,
): Result<RunConfigOverride> => {
  let chunkMode: ChunkModeOverride | null = null;
  if (input.chunkMode !== undefined) {
    const validated = validateChunkMode(input.chunkMode);
    if (validated.error) return err(validated.error);
    chunkMode = validated.data;
  }

  let moneyVocabulary: MoneyVocabularyOverride | null = null;
  if (input.moneyVocabulary !== undefined) {
    const validated = validateMoneyVocabulary(input.moneyVocabulary);
    if (validated.error) return err(validated.error);
    moneyVocabulary = validated.data;
  }

  let extraction: ExtractionOverride | null = null;
  if (input.extraction !== undefined) {
    const validated = validateExtraction(input.extraction);
    if (validated.error) return err(validated.error);
    extraction = validated.data;
  }

  return ok({ chunkMode, moneyVocabulary, extraction });
};
