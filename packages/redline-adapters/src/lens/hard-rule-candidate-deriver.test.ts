import { describe, it, expect } from "vitest";
import { isErr, isOk, ok, err, domainError } from "@redline/redline-domain";
import type { ExtractionElement, IProcurementExtractionReader } from "@redline/redline-domain";
import { makeExtractionHardRuleCandidateDeriver } from "./hard-rule-candidate-deriver";

// The pre-pass `IClassificationLensReader` composes: a document's identifier
// tokens, derived per call from the extraction reader. Hard rules match
// identifiers, never prose (hard-rule-evaluation.ts) — so the whole contract of
// this file is "which tokens count as an identifier", proved against the shapes
// womblex actually serves.

const element = (over: Partial<ExtractionElement> & { text: string }): ExtractionElement => ({
  documentId: "hashA",
  elementOrder: 0,
  page: 1,
  ...over,
});

const readerOver = (
  elementsByDocument: Record<string, readonly ExtractionElement[]>,
): IProcurementExtractionReader => ({
  readElements: async (_evaluationId, documentId) => ok(elementsByDocument[documentId] ?? []),
  readChunks: async () => ok([]),
  readTableCells: async () => ok([]),
});

describe("makeExtractionHardRuleCandidateDeriver — which tokens are identifiers", () => {
  it("keeps tokens carrying both a letter and a digit", async () => {
    const derive = makeExtractionHardRuleCandidateDeriver(
      readerOver({ hashA: [element({ text: "Section SEC-014 and standard ISO9001 apply." })] }),
    );

    const derived = await derive("eval-1", ["hashA"]);

    expect(isOk(derived)).toBe(true);
    if (!isOk(derived)) return;
    expect(derived.data[0]!.subjects).toEqual(["SEC-014", "ISO9001"]);
  });

  it("drops prose words and bare numbers, which no hard rule should claim on", async () => {
    const derive = makeExtractionHardRuleCandidateDeriver(
      readerOver({ hashA: [element({ text: "The tender closes on 30 June for 12 vendors." })] }),
    );

    const derived = await derive("eval-1", ["hashA"]);

    expect(isOk(derived)).toBe(true);
    if (!isOk(derived)) return;
    expect(derived.data[0]!.subjects).toEqual([]);
  });

  it("strips surrounding punctuation but keeps internal hyphens and underscores", async () => {
    const derive = makeExtractionHardRuleCandidateDeriver(
      readerOver({ hashA: [element({ text: "(REQ_12), -SEC-014-; ref: PART-3/A." })] }),
    );

    const derived = await derive("eval-1", ["hashA"]);

    expect(isOk(derived)).toBe(true);
    if (!isOk(derived)) return;
    // "PART-3/A" splits on the slash; the trailing "A" carries no digit and so
    // is not an identifier.
    expect(derived.data[0]!.subjects).toEqual(["REQ_12", "SEC-014", "PART-3"]);
  });

  it("dedupes repeats, preserving first-seen order across elements", async () => {
    const derive = makeExtractionHardRuleCandidateDeriver(
      readerOver({
        hashA: [
          element({ text: "SEC-014 introduced", elementOrder: 0 }),
          element({ text: "REQ_12 then SEC-014 again", elementOrder: 1 }),
        ],
      }),
    );

    const derived = await derive("eval-1", ["hashA"]);

    expect(isOk(derived)).toBe(true);
    if (!isOk(derived)) return;
    expect(derived.data[0]!.subjects).toEqual(["SEC-014", "REQ_12"]);
  });

  it("derives one candidate per requested document, in the requested order", async () => {
    const derive = makeExtractionHardRuleCandidateDeriver(
      readerOver({
        hashA: [element({ text: "SEC-014" })],
        hashB: [element({ documentId: "hashB", text: "REQ_12" })],
      }),
    );

    const derived = await derive("eval-1", ["hashB", "hashA"]);

    expect(isOk(derived)).toBe(true);
    if (!isOk(derived)) return;
    expect(derived.data.map((candidate) => candidate.documentId)).toEqual(["hashB", "hashA"]);
    expect(derived.data[0]!.subjects).toEqual(["REQ_12"]);
  });

  it("yields an empty subject list for a document with no elements, not an error", async () => {
    const derive = makeExtractionHardRuleCandidateDeriver(readerOver({}));

    const derived = await derive("eval-1", ["hashMissing"]);

    expect(isOk(derived)).toBe(true);
    if (!isOk(derived)) return;
    expect(derived.data).toEqual([{ documentId: "hashMissing", subjects: [] }]);
  });

  it("surfaces an extraction failure as a Result error rather than throwing", async () => {
    const derive = makeExtractionHardRuleCandidateDeriver({
      readElements: async () => err(domainError("INFRA_FAILURE", "sidecar unreachable")),
      readChunks: async () => ok([]),
      readTableCells: async () => ok([]),
    });

    const derived = await derive("eval-1", ["hashA"]);

    expect(isErr(derived)).toBe(true);
    if (!isErr(derived)) return;
    expect(derived.error.code).toBe("INFRA_FAILURE");
  });
});
