// DrizzleChunkStore — the ADR-0018 store-side query surface (TypeScript side)
// over the redline_ schema. Implements IChunkStore, so every method returns a
// Result and no driver exception crosses the port. Read-only: the womblex-ingest
// sidecar's load path (the one reader of womblex's Parquet schema) writes
// redline_chunks from `*.chunks.parquet` + `*.embeddings.parquet`; this adapter
// only queries it.
//
// It NEVER selects the embedding: no vector crosses the seam (ADR-0017), so the
// SELECT column list is exactly the domain ChunkRow's fields — the embedding /
// embedding_model columns stay in the store as available data (ADR-0018
// addendum), reachable only when a future release builds the index. The db
// handle is injected as a drizzle instance; the concrete driver (postgres-js in
// production, PGlite in tests) is the caller's choice.
//
// Two operations ship (ADR-0018 addendum): exact fetch by stable key and
// structural fetch by provenance. `findSimilar` is declared by the port but
// refuses with NOT_IMPLEMENTED — the nearest-neighbour predicate needs the
// pgvector/ANN index that is not built this release.

import {
  domainError,
  err,
  ok,
  type ChunkRow,
  type IChunkStore,
  type Result,
  type ScoredChunkRef,
  type StructureFilter,
} from "@redline/redline-domain";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { redlineChunks } from "./schema";

// The domain-shaped projection: exactly the ChunkRow fields, so the embedding
// columns are never named in the query. `sourceHash` is the domain's
// `documentId` (ADR-0014).
const CHUNK_COLUMNS = {
  documentId: redlineChunks.sourceHash,
  chunkId: redlineChunks.chunkId,
  chunkIndex: redlineChunks.chunkIndex,
  contentType: redlineChunks.contentType,
  page: redlineChunks.page,
  text: redlineChunks.text,
  startChar: redlineChunks.startChar,
  endChar: redlineChunks.endChar,
  elementOrder: redlineChunks.elementOrder,
} as const;

// The minimal drizzle surface the store uses. Kept structural so both the
// postgres-js and PGlite drizzle instances satisfy it without a driver import.
interface RedlineDb {
  select: (columns: typeof CHUNK_COLUMNS) => {
    from: (table: unknown) => {
      where: (predicate: unknown) => {
        orderBy: (...columns: unknown[]) => Promise<ChunkRow[]>;
      };
    };
  };
}

const STABLE_ORDER = [asc(redlineChunks.sourceHash), asc(redlineChunks.chunkIndex)];

export class DrizzleChunkStore implements IChunkStore {
  private readonly db: RedlineDb;

  constructor(database: unknown) {
    this.db = database as RedlineDb;
  }

  async fetchChunks(
    evaluationId: string,
    chunkIds: readonly string[],
  ): Promise<Result<readonly ChunkRow[]>> {
    if (chunkIds.length === 0) return ok([]);

    const query = this.query(
      and(
        eq(redlineChunks.evaluationId, evaluationId),
        inArray(redlineChunks.chunkId, [...chunkIds]),
      ),
      "failed to read chunks by id",
    );
    const rows = await query;
    if (rows.error) return err(rows.error);

    // An exact lookup returns each id at most once; impose the requested order
    // client-side (a missing key is simply absent — not an error).
    const byId = new Map(rows.data.map((row) => [row.chunkId, row]));
    const ordered = chunkIds
      .map((chunkId) => byId.get(chunkId))
      .filter((row): row is ChunkRow => row !== undefined);
    return ok(ordered);
  }

  async fetchByStructure(
    evaluationId: string,
    filter: StructureFilter,
  ): Promise<Result<readonly ChunkRow[]>> {
    const predicates: SQL[] = [eq(redlineChunks.evaluationId, evaluationId)];
    if (filter.documentId !== undefined) {
      predicates.push(eq(redlineChunks.sourceHash, filter.documentId));
    }
    if (filter.contentType !== undefined) {
      predicates.push(eq(redlineChunks.contentType, filter.contentType));
    }
    if (filter.page !== undefined) {
      predicates.push(eq(redlineChunks.page, filter.page));
    }
    return this.query(and(...predicates), "failed to read chunks by structure");
  }

  // ADR-0018 addendum: vector similarity search is deferred. The port declares
  // findSimilar so a later release adds it without a seam change; until the
  // pgvector/ANN index is built it refuses honestly rather than returning a fake
  // ranking. The embedding is in the store as data — this is a missing index,
  // not missing data.
  async findSimilar(): Promise<Result<readonly ScoredChunkRef[]>> {
    return err(
      domainError(
        "NOT_IMPLEMENTED",
        "findSimilar is deferred (ADR-0018 addendum) — the pgvector/ANN index is not built yet",
      ),
    );
  }

  private async query(
    predicate: unknown,
    failureMessage: string,
  ): Promise<Result<readonly ChunkRow[]>> {
    try {
      const rows = await this.db
        .select(CHUNK_COLUMNS)
        .from(redlineChunks)
        .where(predicate)
        .orderBy(...STABLE_ORDER);
      return ok(rows);
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", failureMessage, cause));
    }
  }
}
