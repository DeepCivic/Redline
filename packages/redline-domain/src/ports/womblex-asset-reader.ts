import type { Result } from "../result";

// Read-only view of one womblex run's shards, served verbatim. This is the one
// seam redline reads through: an adapter fetches a page of rows for a named shard
// family and hands them back with womblex's own column names and values, so a
// client can join what it read back to the source and to womblex's own contract.
//
// Nothing here is remapped or derived. A row is a bag of womblex columns
// (`source_hash`, `elem_order`, `parent_elem_order`, …), not a camelCase read
// model of redline's invention. Where redline computes a signal womblex did not
// write, it belongs above this port, under its own labelled key — never folded in
// among these columns as though the engine had written it.

// A shard column's name and Arrow type, carried so a client can discover a
// schema without reading a single row of document body.
export interface ShardColumn {
  readonly name: string;
  readonly type: string;
}

// One row, verbatim. Keys are womblex's column names; values are what the shard
// held, with only the conversions JSON forces (a decimal128 is its exact digit
// string, never a float — re-normalising a money amount corrupts it).
export type ShardRow = Readonly<Record<string, unknown>>;

// One page of one shard family for one run. `returned`/`available`/`truncated`
// state what the page withheld, so a capped read is visible to the caller instead
// of looking like the whole answer. An empty `rows` with populated `columns` is a
// real answer — "no rows", distinct from "no such asset".
export interface ShardPage {
  readonly asset: string;
  readonly runId: string;
  readonly columns: readonly ShardColumn[];
  readonly rows: readonly ShardRow[];
  readonly returned: number;
  readonly available: number;
  readonly truncated: boolean;
}

// Addresses one page. `documentId` filters to one document across either identity
// spelling (`source_hash` or `document_id`); omitting it reads the whole run.
// `limit`/`offset` page the window and are the adapter's cursor — deliberately
// distinct from any `page` column a shard happens to carry. A negative `limit`
// serves every matching row: a caller that filters or aggregates above this port
// cannot page honestly until it has seen the whole set, and only the shards
// carrying no document body are ever read that way.
export interface WomblexAssetRequest {
  readonly corpusId: string;
  readonly runId: string;
  readonly asset: string;
  readonly documentId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface IWomblexAssetReader {
  readShard(request: WomblexAssetRequest): Promise<Result<ShardPage>>;
}
