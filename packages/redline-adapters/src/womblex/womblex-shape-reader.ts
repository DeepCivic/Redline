// WomblexShapeReader — implements the domain's IWomblexShapeReader over the
// womblex-ingest sidecar's shape routes (`GET /runs/{corpus}/shape` and
// `GET /runs/{corpus}/{run}/shape`).
//
// The aggregation itself lives in the sidecar, where Parquet's own structure
// makes it cheap: row counts come from the file footer and tallies project a
// single column, so asking how big a thing is never decodes the thing. This
// adapter is the same thin HTTP + JSON seam as the shard reader beside it.

import {
  domainError,
  type CorpusShape,
  type IWomblexShapeReader,
  type Result,
  type WomblexShapeRequest,
  err,
} from "@redline/redline-domain";
import type { HttpClient, HttpResponse } from "./womblex-asset-reader";
import { parseErrorBody } from "./wire";
import { parseCorpusShape } from "./shape-wire";

export interface WomblexShapeReaderOptions {
  // Base URL of the womblex-ingest sidecar, e.g. "http://womblex-ingest:8000".
  readonly baseUrl: string;
  readonly httpClient: HttpClient;
}

export class WomblexShapeReader implements IWomblexShapeReader {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;

  constructor(options: WomblexShapeReaderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
  }

  async readShape(request: WomblexShapeRequest): Promise<Result<CorpusShape>> {
    // A document is sized within the run that produced it. Dropping an
    // unaddressable documentId would answer a document-scoped question with a
    // whole-corpus shape, as an `ok` — the caller would have no way to tell.
    if (request.documentId !== undefined && request.runId === undefined) {
      return err(
        domainError("VALIDATION_FAILED", "a documentId needs the runId that produced it"),
      );
    }

    let response: HttpResponse;
    try {
      response = await this.httpClient(this.shapeUrl(request));
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

    return parseCorpusShape(body);
  }

  private shapeUrl(request: WomblexShapeRequest): string {
    const corpus = encodeURIComponent(request.corpusId);
    if (request.runId === undefined) {
      return `${this.baseUrl}/runs/${corpus}/shape`;
    }

    const path = `${this.baseUrl}/runs/${corpus}/${encodeURIComponent(request.runId)}/shape`;
    if (request.documentId === undefined) return path;
    return `${path}?documentId=${encodeURIComponent(request.documentId)}`;
  }
}
