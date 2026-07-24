// NumbatchFinancialExtractor — implements the domain's IFinancialExtractor over
// the financial extension's read seam (services/numbatch/financial_extension,
// GET /financial-extractions/{source_doc_id}). For each document in a response
// group it reads the figures the Thread 7 worker wrote, maps each Numbatch
// topic_id → the evaluation's requirementId, and shapes them into
// FinancialExtraction[] (estimateAud: number | null + description + provenance).
//
// The topic_id ↔ requirementId translation is the same binding the classifier
// uses (Thread 5): redline speaks "requirement", Numbatch speaks "topic". Topics
// with no mapping are dropped, not invented — the binding is the source of truth.
//
// Designed "as if C" (ADR-0001): the only coupling to Numbatch is HTTP + JSON.

import {
  domainError,
  type FinancialExtraction,
  type FinancialExtractionRequest,
  type IFinancialExtractor,
  type Result,
  err,
  ok,
} from "@redline/redline-domain";
import {
  parseDocumentExtractions,
  parseErrorBody,
  type WireDocumentExtractions,
} from "./financial-wire";

// A minimal, `fetch`-shaped seam so tests inject a fake without a live server and
// the adapter never assumes a global fetch. GET-only — the read seam takes no body.
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpClient = (url: string) => Promise<HttpResponse>;

// Maps each Numbatch profile topic_id back to the evaluation's requirementId.
// A subset of the classifier's NumbatchProfileBinding — the extractor needs only
// the mapping, not the profile id or strategy.
export interface NumbatchProfileBinding {
  readonly topicToRequirement: Readonly<Record<string, string>>;
}

export interface NumbatchFinancialExtractorOptions {
  readonly baseUrl: string;
  readonly httpClient: HttpClient;
  readonly binding: NumbatchProfileBinding;
}

export class NumbatchFinancialExtractor implements IFinancialExtractor {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;
  private readonly binding: NumbatchProfileBinding;

  constructor(options: NumbatchFinancialExtractorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
    this.binding = options.binding;
  }

  async extractFinancials(
    request: FinancialExtractionRequest,
  ): Promise<Result<readonly FinancialExtraction[]>> {
    const rows: FinancialExtraction[] = [];
    for (const documentId of request.documentIds) {
      const document = await this.readDocument(documentId);
      if (document.error) return err(document.error);
      rows.push(...this.mapDocument(document.data));
    }
    return ok(rows);
  }

  private async readDocument(
    documentId: string,
  ): Promise<Result<WireDocumentExtractions>> {
    const url = `${this.baseUrl}/financial-extractions/${encodeURIComponent(documentId)}`;

    let response: HttpResponse;
    try {
      response = await this.httpClient(url);
    } catch (cause) {
      return err(
        domainError("INFRA_FAILURE", "numbatch financial read is unreachable", cause),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      return err(
        domainError(
          "EXTRACTION_FAILED",
          "numbatch financial read returned a non-JSON body",
          cause,
        ),
      );
    }

    if (!response.ok) return err(parseErrorBody(response.status, body));
    return parseDocumentExtractions(body);
  }

  // One FinancialExtraction per (document, matched requirement). Topics with no
  // requirement mapping are dropped rather than invented. estimateAud is the
  // parsed figure or null; description is always populated (the fallback prose).
  private mapDocument(
    document: WireDocumentExtractions,
  ): readonly FinancialExtraction[] {
    const rows: FinancialExtraction[] = [];
    for (const extraction of document.extractions) {
      const requirementId = this.binding.topicToRequirement[extraction.topicId];
      if (!requirementId) continue;
      rows.push({
        documentId: document.sourceDocId,
        requirementId,
        elementOrder: extraction.sourceElemOrder ?? 0,
        estimateAud: extraction.amount,
        description: extraction.description,
      });
    }
    return rows;
  }
}
