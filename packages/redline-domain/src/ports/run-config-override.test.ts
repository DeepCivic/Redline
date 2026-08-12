import { describe, it, expect } from "vitest";
import { isOk, isErr } from "../result";
import {
  makeRunConfigOverride,
  type ChunkModeOverride,
  type MoneyVocabularyOverride,
} from "./run-config-override";

// The allow-listed run-config override — the defined slice of the womblex config
// a Create Corpus form may author (design-principles.md "defined allow-list", not
// the whole file). Three groups: the stage sequence (owned by TriggerRunRequest),
// the chunk mode (`chunking_model` null for offline token chunking vs set for
// AI/semantic, plus `chunk_size` / `chunk_tables`), and the money vocabulary
// (`extra_header_terms` / `extra_veto_terms` / `default_currency`). Every field is
// optional — a blank form field inherits the redline.yaml default below the seam,
// so an empty override is valid and means "run the file as-is". The smart
// constructor's job is to keep a *malformed* override — a negative chunk size, a
// blank vocabulary term, a non-ISO currency — off the wire, not to fill defaults.

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

describe("makeRunConfigOverride — the allow-listed slice of the womblex config", () => {
  it("accepts an empty override — every field blank inherits the file default", () => {
    const override = makeRunConfigOverride({});

    expect(isOk(override)).toBe(true);
    if (!isOk(override)) return;
    expect(override.data.chunkMode).toBeNull();
    expect(override.data.moneyVocabulary).toBeNull();
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
});
