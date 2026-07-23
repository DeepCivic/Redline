// WomblexExtractionReader — implements the domain's IProcurementExtractionReader
// over the womblex-ingest sidecar's Parquet→JSON read seam
// (`GET /extractions/{evaluationId}/{documentId}`).
//
// Thread 4 decision (build plan §8 #2): the boundary is JSON. The heavy
// Parquet/womblex stack lives entirely in the Python sidecar, which reads its own
// shards and serves JSON; this adapter never links a Parquet reader. It fetches one
// document-scoped payload and slices it into elements / chunks / table cells, so all
// three port methods hit the same durable object and share provenance.
//
// Designed "as if C" (ADR-0001): the only coupling to the sidecar is HTTP + JSON.

import {
  domainError,
  type ExtractionChunk,
  type ExtractionElement,
  type ExtractionTableCell,
  type IProcurementExtractionReader,
  type Result,
  err,
  ok,
} from "@redline/redline-domain";
import {
  parseDocumentExtraction,
  parseErrorBody,
  type WireDocumentExtraction,
} from "./wire";

// A minimal, `fetch`-shaped seam so tests inject a fake without a live server and
// the adapter never assumes a global fetch. Only what the reader needs is modelled.
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpClient = (url: string) => Promise<HttpResponse>;

export interface WomblexExtractionReaderOptions {
  // Base URL of the womblex-ingest sidecar, e.g. "http://womblex-ingest:8000".
  readonly baseUrl: string;
  readonly httpClient: HttpClient;
}

export class WomblexExtractionReader implements IProcurementExtractionReader {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;

  constructor(options: WomblexExtractionReaderOptions) {
    // Trim a trailing slash so URL joining stays predictable.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
  }

  async readElements(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly ExtractionElement[]>> {
    const doc = await this.fetchDocument(evaluationId, documentId);
    if (doc.error) return err(doc.error);
    return ok(doc.data.elements);
  }

  async readChunks(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly ExtractionChunk[]>> {
    const doc = await this.fetchDocument(evaluationId, documentId);
    if (doc.error) return err(doc.error);
    return ok(doc.data.chunks);
  }

  async readTableCells(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly ExtractionTableCell[]>> {
    const doc = await this.fetchDocument(evaluationId, documentId);
    if (doc.error) return err(doc.error);
    return ok(doc.data.tableCells);
  }

  // Fetch + validate one document's read model. All network/parse failures are
  // caught here and returned as DomainErrors — nothing throws across the port edge.
  private async fetchDocument(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<WireDocumentExtraction>> {
    const url = `${this.baseUrl}/extractions/${encodeURIComponent(evaluationId)}/${encodeURIComponent(documentId)}`;

    let response: HttpResponse;
    try {
      response = await this.httpClient(url);
    } catch (cause) {
      return err(
        domainError("INFRA_FAILURE", "womblex-ingest is unreachable", cause),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      return err(
        domainError("EXTRACTION_FAILED", "womblex-ingest returned a non-JSON body", cause),
      );
    }

    if (!response.ok) {
      return err(parseErrorBody(response.status, body));
    }

    return parseDocumentExtraction(body);
  }
}
