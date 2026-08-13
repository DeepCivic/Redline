import { describe, it, expect } from "vitest";
import { isOk, isErr } from "../result";
import {
  makeRunConfigOverride,
  type ChunkModeOverride,
  type ExtractionOverride,
  type MoneyVocabularyOverride,
} from "./run-config-override";

// The allow-listed run-config override — the defined slice of the womblex config
// a Create Corpus form may author (design-principles.md "defined allow-list", not
// the whole file). Four groups: the stage sequence (owned by TriggerRunRequest),
// the chunk mode (`chunking_model` null for offline token chunking vs set for
// AI/semantic, plus `chunk_size` / `chunk_tables`), the money vocabulary
// (`extra_header_terms` / `extra_veto_terms` / `default_currency`) and the
// extraction settings (`extraction.ocr.engine` / `extraction.ocr.dpi`). Every
// field is optional — a blank form field inherits the redline.yaml default below
// the seam, so an empty override is valid and means "run the file as-is". The
// smart constructor's job is to keep a *malformed* override — a negative chunk
// size, a blank vocabulary term, a non-ISO currency, an out-of-range dpi — off
// the wire, not to fill defaults.

const chunkMode = (over: Partial<ChunkModeOverride> = {}): ChunkModeOverride => ({
  chunkingModel: null,
  chunkSize: 480,
  chunkTables: true,
  ...over,
});

const moneyVocabulary = (
  over: Partial<MoneyVocabularyOverride> = {},
): MoneyVocabularyOverride => ({
  extraHeaderTerms: ["subtotal", "rrp"],
  extraVetoTerms: ["centre"],
  defaultCurrency: "AUD",
  ...over,
});

const extraction = (over: Partial<ExtractionOverride> = {}): ExtractionOverride => ({
  ocrEngine: "paddleocr",
  ocrDpi: 300,
  ...over,
});

describe("makeRunConfigOverride — the allow-listed slice of the womblex config", () => {
  it("accepts an empty override — every field blank inherits the file default", () => {
    const override = makeRunConfigOverride({});

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.chunkMode).toBeNull();
    expect(override.data.moneyVocabulary).toBeNull();
    expect(override.data.extraction).toBeNull();
  });

  it("carries an offline token-chunking mode through unaltered", () => {
    const override = makeRunConfigOverride({ chunkMode: chunkMode({ chunkingModel: null }) });

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.chunkMode).toEqual({
      chunkingModel: null,
      chunkSize: 480,
      chunkTables: true,
    });
  });

  it("carries an AI/semantic chunking model through as the set value", () => {
    const override = makeRunConfigOverride({
      chunkMode: chunkMode({ chunkingModel: "kanon-2-chunker" }),
    });

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.chunkMode?.chunkingModel).toBe("kanon-2-chunker");
  });

  it("refuses a non-positive chunk size — a run cannot chunk to zero tokens", () => {
    const zero = makeRunConfigOverride({ chunkMode: chunkMode({ chunkSize: 0 }) });
    const negative = makeRunConfigOverride({ chunkMode: chunkMode({ chunkSize: -1 }) });

    expect(isErr(zero)).toBe(true);
    expect(isErr(negative)).toBe(true);
    if (!isErr(zero)) return;
    expect(zero.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a non-integer chunk size — token counts are whole", () => {
    const override = makeRunConfigOverride({ chunkMode: chunkMode({ chunkSize: 480.5 }) });

    expect(isErr(override)).toBe(true);
    if (!isErr(override)) return;
    expect(override.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a blank AI chunking model — set it or leave it null, never empty", () => {
    const override = makeRunConfigOverride({ chunkMode: chunkMode({ chunkingModel: "  " }) });

    expect(isErr(override)).toBe(true);
    if (!isErr(override)) return;
    expect(override.error.code).toBe("VALIDATION_FAILED");
  });

  it("carries corpus-specific money vocabulary through, trimmed and de-duplicated", () => {
    const override = makeRunConfigOverride({
      moneyVocabulary: moneyVocabulary({
        extraHeaderTerms: [" subtotal ", "rrp", "subtotal"],
        extraVetoTerms: ["centre"],
        defaultCurrency: "aud",
      }),
    });

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.moneyVocabulary?.extraHeaderTerms).toEqual(["subtotal", "rrp"]);
    // ISO 4217 codes are upper-case; the form's free text is normalised here.
    expect(override.data.moneyVocabulary?.defaultCurrency).toBe("AUD");
  });

  it("refuses a blank money vocabulary term — a header/veto term must be a word", () => {
    const override = makeRunConfigOverride({
      moneyVocabulary: moneyVocabulary({ extraHeaderTerms: ["subtotal", "  "] }),
    });

    expect(isErr(override)).toBe(true);
    if (!isErr(override)) return;
    expect(override.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a default currency that is not a three-letter ISO 4217 code", () => {
    const override = makeRunConfigOverride({
      moneyVocabulary: moneyVocabulary({ defaultCurrency: "dollars" }),
    });

    expect(isErr(override)).toBe(true);
    if (!isErr(override)) return;
    expect(override.error.code).toBe("VALIDATION_FAILED");
  });

  it("accepts a money vocabulary with only a default currency (both term lists empty)", () => {
    const override = makeRunConfigOverride({
      moneyVocabulary: { extraHeaderTerms: [], extraVetoTerms: [], defaultCurrency: "NZD" },
    });

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.moneyVocabulary?.defaultCurrency).toBe("NZD");
    expect(override.data.moneyVocabulary?.extraHeaderTerms).toEqual([]);
  });

  // The extraction group. `redline.yaml` marks `extraction.ocr.engine: paddleocr`
  // LOAD-BEARING because a VLM engine returns markdown with no regions and so
  // deletes every table cell on a scanned page — which is what a scanned tender
  // is made of. That makes it the setting a first run most needs to reach, and a
  // first run has nothing to orphan by changing it.

  it("carries an authored OCR engine and dpi through", () => {
    const override = makeRunConfigOverride({
      extraction: extraction({ ocrEngine: "mistral-ocr", ocrDpi: 400 }),
    });

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.extraction).toEqual({ ocrEngine: "mistral-ocr", ocrDpi: 400 });
  });

  it("normalises the engine name — the engine resolves its aliases lower-cased", () => {
    const override = makeRunConfigOverride({
      extraction: extraction({ ocrEngine: "  PaddleOCR " }),
    });

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.extraction?.ocrEngine).toBe("paddleocr");
  });

  it("refuses a blank OCR engine — a named engine or no extraction group at all", () => {
    const override = makeRunConfigOverride({ extraction: extraction({ ocrEngine: "   " }) });

    expect(isErr(override)).toBe(true);
    if (!isErr(override)) return;
    expect(override.error.code).toBe("VALIDATION_FAILED");
  });

  // The engine bounds dpi 72–600 on `OCRConfig`. Mirrored here so an out-of-range
  // value is refused at the seam rather than raising inside a run that has
  // already started extracting.
  it("refuses an OCR dpi outside the engine's own 72–600 bounds", () => {
    const tooLow = makeRunConfigOverride({ extraction: extraction({ ocrDpi: 71 }) });
    const tooHigh = makeRunConfigOverride({ extraction: extraction({ ocrDpi: 601 }) });

    expect(isErr(tooLow)).toBe(true);
    expect(isErr(tooHigh)).toBe(true);
    if (!isErr(tooLow)) return;
    expect(tooLow.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a non-integer OCR dpi — a render resolution is whole", () => {
    const override = makeRunConfigOverride({ extraction: extraction({ ocrDpi: 300.5 }) });

    expect(isErr(override)).toBe(true);
    if (!isErr(override)) return;
    expect(override.error.code).toBe("VALIDATION_FAILED");
  });

  it("accepts an extraction group on its own, with the other two left blank", () => {
    const override = makeRunConfigOverride({ extraction: extraction() });

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.extraction?.ocrEngine).toBe("paddleocr");
    expect(override.data.chunkMode).toBeNull();
    expect(override.data.moneyVocabulary).toBeNull();
  });
});
