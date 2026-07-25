// WomblexEmbeddingReader — implements the domain's IEmbeddingReader over the
// womblex-ingest sidecar's retrieval read seam
// (`GET /embeddings/{evaluationId}/{documentId}`, ADR-0014).
//
// Like the Thread 4 extraction reader, the heavy Parquet/womblex stack lives in
// the Python sidecar, which reads its own `*.embeddings.parquet` siblings and
// serves JSON float arrays; this adapter never links a Parquet reader. It parses
// the vectors into Float32Array and caches per document — the two constraints the
// cloud deployment target makes binding rather than advisory (ADR-0014):
//
//   - Float32Array, not number[]: half the resident memory for precision cosine
//     similarity cannot use, which matters under a container memory limit.
//   - Cache per document: extraction output is immutable and content-addressed, so
//     a document's vectors never change — the transfer is payable once per
//     evaluation, not once per classification run. Without the cache the cloud
//     economics favour server-side retrieval.
//
// Designed "as if C" (ADR-0001): the only coupling to the sidecar is HTTP + JSON.

import {
  domainError,
  type DocumentEmbeddings,
  type IEmbeddingReader,
  type Result,
  err,
  ok,
} from "@redline/redline-domain";
import { parseDocumentEmbeddings, parseErrorBody } from "./wire";

// A minimal, `fetch`-shaped seam so tests inject a fake without a live server and
// the adapter never assumes a global fetch. Only what the reader needs is modelled.
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpClient = (url: string) => Promise<HttpResponse>;

export interface WomblexEmbeddingReaderOptions {
  // Base URL of the womblex-ingest sidecar, e.g. "http://womblex-ingest:8000".
  readonly baseUrl: string;
  readonly httpClient: HttpClient;
}

export class WomblexEmbeddingReader implements IEmbeddingReader {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;
  // Keyed on (evaluationId, documentId); vectors are immutable so a hit is safe
  // for the lifetime of this reader. Only successful reads are cached.
  private readonly cache = new Map<string, DocumentEmbeddings>();

  constructor(options: WomblexEmbeddingReaderOptions) {
    // Trim a trailing slash so URL joining stays predictable.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
  }

  async readEmbeddings(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<DocumentEmbeddings>> {
    const cacheKey = `${evaluationId}::${documentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return ok(cached);

    const fetched = await this.fetchEmbeddings(evaluationId, documentId);
    if (fetched.error) return err(fetched.error);

    this.cache.set(cacheKey, fetched.data);
    return ok(fetched.data);
  }

  // Fetch + validate one document's vectors. All network/parse failures are
  // caught here and returned as DomainErrors — nothing throws across the port edge.
  private async fetchEmbeddings(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<DocumentEmbeddings>> {
    const url = `${this.baseUrl}/embeddings/${encodeURIComponent(evaluationId)}/${encodeURIComponent(documentId)}`;

    let response: HttpResponse;
    try {
      response = await this.httpClient(url);
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "womblex-ingest is unreachable", cause));
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

    return parseDocumentEmbeddings(body);
  }
}
