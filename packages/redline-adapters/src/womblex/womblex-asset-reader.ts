// WomblexAssetReader — implements the domain's IWomblexAssetReader over the
// womblex-ingest sidecar's run-scoped shard route
// (`GET /runs/{corpus}/{run}/shards/{asset}`).
//
// The boundary is JSON, deliberately. The heavy Parquet/womblex stack lives
// entirely in the Python sidecar, which reads its own shards and serves JSON;
// this adapter never links a Parquet reader. It fetches one page of one shard
// family and hands it back with womblex's own column names and values untouched —
// no remap, no derived signal folded in.
//
// Designed "as if C": the only coupling to the sidecar is HTTP + JSON.

import {
  domainError,
  type IWomblexAssetReader,
  type Result,
  type ShardPage,
  type WomblexAssetRequest,
  err,
} from "@redline/redline-domain";
import { parseErrorBody, parseShardPage } from "./wire";

// A minimal, `fetch`-shaped seam so tests inject a fake without a live server and
// the adapter never assumes a global fetch. Only what the reader needs is modelled.
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpClient = (url: string) => Promise<HttpResponse>;

export interface WomblexAssetReaderOptions {
  // Base URL of the womblex-ingest sidecar, e.g. "http://womblex-ingest:8000".
  readonly baseUrl: string;
  readonly httpClient: HttpClient;
}

export class WomblexAssetReader implements IWomblexAssetReader {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;

  constructor(options: WomblexAssetReaderOptions) {
    // Trim a trailing slash so URL joining stays predictable.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
  }

  async readShard(request: WomblexAssetRequest): Promise<Result<ShardPage>> {
    const url = this.shardUrl(request);

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

    return parseShardPage(body);
  }

  private shardUrl(request: WomblexAssetRequest): string {
    const path =
      `${this.baseUrl}/runs/${encodeURIComponent(request.corpusId)}/` +
      `${encodeURIComponent(request.runId)}/shards/${encodeURIComponent(request.asset)}`;

    const query = new URLSearchParams();
    if (request.documentId !== undefined) query.set("documentId", request.documentId);
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    if (request.offset !== undefined) query.set("offset", String(request.offset));

    const suffix = query.toString();
    return suffix === "" ? path : `${path}?${suffix}`;
  }
}
