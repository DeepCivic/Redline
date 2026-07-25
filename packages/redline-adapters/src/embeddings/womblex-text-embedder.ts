// WomblexTextEmbedder — implements the domain's ITextEmbedder over the
// womblex-ingest sidecar's query-embedding seam (`POST /embeddings/query`,
// ADR-0014 / Thread 20a).
//
// redline's TypeScript links no embedding model, so the sidecar — which already
// owns chunk embedding — embeds a topic definition too, in the *same* space
// (same declared model, same dimensions, L2-normalised). This adapter POSTs the
// text, narrows the response, and parses `values` into a Float32Array so a query
// vector and a chunk vector share one representation and cosine similarity is a
// dot product (Thread 22).
//
// Designed "as if C" (ADR-0001): the only coupling to the sidecar is HTTP + JSON.

import {
  type ITextEmbedder,
  type QueryEmbedding,
  type Result,
  domainError,
  err,
} from "@redline/redline-domain";
import { parseErrorBody, parseQueryEmbedding } from "./text-embedder-wire";

// A minimal, method-aware HTTP seam so the embedder can POST a JSON body and
// tests inject a fake without a live server. Only what the embedder needs.
export interface HttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly body: unknown;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export interface WomblexTextEmbedderOptions {
  // Base URL of the womblex-ingest sidecar, e.g. "http://womblex-ingest:8000".
  readonly baseUrl: string;
  readonly httpClient: HttpClient;
}

export class WomblexTextEmbedder implements ITextEmbedder {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;
  // A topic definition's text is fixed for an evaluation and the vector is
  // immutable for a given model, so a hit is safe for the reader's lifetime. Only
  // successful embeds are cached; a transient failure can be retried. This keeps
  // Thread 22 from re-embedding the same handful of definitions per document.
  private readonly cache = new Map<string, QueryEmbedding>();

  constructor(options: WomblexTextEmbedderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
  }

  async embed(text: string): Promise<Result<QueryEmbedding>> {
    // Blank text is a caller mistake caught before the round trip: the sidecar
    // would reject it (INVALID_REQUEST), so we save the request and speak the
    // same VALIDATION_FAILED the wire mapper would.
    if (text.trim() === "") {
      return err(domainError("VALIDATION_FAILED", "text must not be empty"));
    }

    const cached = this.cache.get(text);
    if (cached) return { data: cached };

    const embedded = await this.postQuery(text);
    if (embedded.error) return err(embedded.error);

    this.cache.set(text, embedded.data);
    return { data: embedded.data };
  }

  // POST + validate one query vector. Transport / non-JSON / non-2xx failures are
  // caught here and returned as DomainErrors — nothing throws across the port edge.
  private async postQuery(text: string): Promise<Result<QueryEmbedding>> {
    let response: HttpResponse;
    try {
      response = await this.httpClient({
        method: "POST",
        url: `${this.baseUrl}/embeddings/query`,
        body: { text },
      });
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "womblex-ingest is unreachable", cause));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      return err(
        domainError("INFRA_FAILURE", "womblex-ingest returned a non-JSON body", cause),
      );
    }

    if (!response.ok) return err(parseErrorBody(response.status, body));
    return parseQueryEmbedding(body);
  }
}
