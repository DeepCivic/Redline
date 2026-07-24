import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import { typedDisplayCell } from "@rbrasier/domain";
import {
  NumbatchFinancialExtractor,
  type HttpClient,
  type HttpResponse,
  type NumbatchProfileBinding,
} from "./numbatch-financial-extractor";
import extractions from "./__fixtures__/document-extractions.json";

// A captured payload from the financial extension's read seam
// (GET /financial-extractions/{source_doc_id}, Thread 6/8 overlay). The contract:
// this adapter turns that JSON into FinancialExtraction[], mapping each Numbatch
// topic_id to the evaluation's requirementId and coercing the currency string to
// a real number for ProcurementResponse.costing.estimateAud.

const jsonResponse = (status: number, body: unknown): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Reuse the same binding shape as the classifier: which topic_ids belong to this
// evaluation and how they map back to redline requirementIds.
const binding: NumbatchProfileBinding = {
  topicToRequirement: {
    "t-data-residency": "req-data-residency",
    "t-support-sla": "req-support-sla",
  },
};

const extractorFor = (client: HttpClient) =>
  new NumbatchFinancialExtractor({
    baseUrl: "http://numbatch-backend:8000/",
    httpClient: client,
    binding,
  });

const request = () => ({
  evaluationId: "eval-9",
  responseGroupId: "g1",
  documentIds: ["82f9355e"],
});

describe("NumbatchFinancialExtractor — extraction → costing contract", () => {
  it("reads a document's figures and maps topic_id → requirementId", async () => {
    const client: HttpClient = async () => jsonResponse(200, extractions);
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(2);
    const residency = result.data.find(
      (row) => row.requirementId === "req-data-residency",
    );
    expect(residency).toBeDefined();
    expect(residency!.documentId).toBe("82f9355e");
    expect(residency!.estimateAud).toBe(1500.5);
    expect(residency!.description).toBe("Sovereign hosting — annual");
    expect(residency!.elementOrder).toBe(7);
  });

  it("produces a numeric currency cell via typedDisplayCell (exit criterion)", async () => {
    const client: HttpClient = async () => jsonResponse(200, extractions);
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const residency = result.data.find(
      (row) => row.requirementId === "req-data-residency",
    )!;
    // The whole point of the numeric estimateAud: Wayfinder's typed-cell helper
    // renders it as a real numeric Excel cell, not text (build plan §1, §9).
    const cell = typedDisplayCell("currency", String(residency.estimateAud));
    expect(cell.isNumeric).toBe(true);
    expect(cell.value).toBe(1500.5);
  });

  it("keeps a description fallback with a null estimate", async () => {
    const client: HttpClient = async () => jsonResponse(200, extractions);
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const support = result.data.find((row) => row.requirementId === "req-support-sla")!;
    expect(support.estimateAud).toBeNull();
    expect(support.description).toBe("Priced on application; see section 4.");
  });

  it("reads every document in the group and concatenates their figures", async () => {
    const second = {
      source_doc_id: "5c1a7be0",
      extractions: [
        {
          topic_id: "t-data-residency",
          amount: "800.00",
          currency: "AUD",
          description: "Onshore storage",
          source_elem_order: 3,
        },
      ],
    };
    const client: HttpClient = async (url) =>
      url.endsWith("5c1a7be0")
        ? jsonResponse(200, second)
        : jsonResponse(200, extractions);
    const extractor = new NumbatchFinancialExtractor({
      baseUrl: "http://numbatch-backend:8000",
      httpClient: client,
      binding,
    });

    const result = await extractor.extractFinancials({
      evaluationId: "eval-9",
      responseGroupId: "g1",
      documentIds: ["82f9355e", "5c1a7be0"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // 2 from the first doc + 1 from the second.
    expect(result.data).toHaveLength(3);
    expect(result.data.filter((row) => row.documentId === "5c1a7be0")).toHaveLength(1);
  });

  it("drops a topic with no requirement mapping rather than inventing one", async () => {
    const body = {
      source_doc_id: "82f9355e",
      extractions: [
        {
          topic_id: "t-unmapped",
          amount: "10.00",
          currency: "AUD",
          description: "rogue",
          source_elem_order: 1,
        },
      ],
    };
    const client: HttpClient = async () => jsonResponse(200, body);
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(0);
  });

  it("treats a document with no extractions as an empty result", async () => {
    const client: HttpClient = async () =>
      jsonResponse(200, { source_doc_id: "82f9355e", extractions: [] });
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(0);
  });

  it("maps a transport failure to INFRA_FAILURE without throwing", async () => {
    const client: HttpClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });

  it("maps a non-2xx read to a DomainError from the body detail", async () => {
    const client: HttpClient = async () =>
      jsonResponse(500, { detail: "financial store unavailable" });
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
  });

  it("fails with EXTRACTION_FAILED on a malformed amount", async () => {
    const body = {
      source_doc_id: "82f9355e",
      extractions: [
        {
          topic_id: "t-data-residency",
          amount: "not-a-number",
          currency: "AUD",
          description: "bad",
          source_elem_order: 1,
        },
      ],
    };
    const client: HttpClient = async () => jsonResponse(200, body);
    const extractor = extractorFor(client);

    const result = await extractor.extractFinancials(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
  });
});
