// DrizzleStagedCorpusReader — the staged-corpus picker's query surface over the
// redline_ schema. Implements IStagedCorpusReader, so every method returns a
// Result and no driver exception crosses the port. Read-only: the
// womblex-ingest sidecar's load path writes redline_chunks; this adapter only
// queries it, which is what makes "staged" mean "actually readable" rather than
// "an operator says so".
//
// It never selects the embedding — no vector crosses the seam (ADR-0017) — and
// it never selects chunk text in bulk: a corpus is ~90k chunks, so the preview
// is fetched from the first chunk of each document only.

import {
  domainError,
  err,
  ok,
  type IStagedCorpusReader,
  type Result,
  type StagedCorpus,
  type StagedDocument,
} from "@redline/redline-domain";
import { asc, count, countDistinct, eq, and } from "drizzle-orm";
import { redlineChunks } from "./schema";

// Long enough to tell two tender responses apart, short enough that a hundred
// documents do not ship a megabyte of prose to the browser.
const PREVIEW_LIMIT = 200;

// womblex numbers a document's chunks from zero, so chunk zero is its opening
// passage. A document whose first chunk is absent (a partial load) still lists,
// with no preview, rather than vanishing from a picker the operator is using to
// decide what to evaluate.
const FIRST_CHUNK_INDEX = 0;

const CORPUS_COLUMNS = {
  corpusId: redlineChunks.evaluationId,
  documentCount: countDistinct(redlineChunks.sourceHash),
} as const;

const DOCUMENT_COLUMNS = {
  documentId: redlineChunks.sourceHash,
  chunkCount: count(),
} as const;

const PREVIEW_COLUMNS = {
  documentId: redlineChunks.sourceHash,
  text: redlineChunks.text,
} as const;

// The minimal drizzle surface this reader uses, kept structural so the
// postgres-js and PGlite instances both satisfy it without a driver import. The
// row type is the caller's claim about the column set it passed.
interface GroupedQuery<TRow> {
  orderBy: (...columns: unknown[]) => Promise<TRow[]>;
}

interface FilteredQuery<TRow> extends GroupedQuery<TRow> {
  groupBy: (...columns: unknown[]) => GroupedQuery<TRow>;
}

interface FromQuery<TRow> {
  where: (predicate: unknown) => FilteredQuery<TRow>;
  groupBy: (...columns: unknown[]) => GroupedQuery<TRow>;
}

interface RedlineDb {
  select: <TRow>(columns: Record<string, unknown>) => {
    from: (table: unknown) => FromQuery<TRow>;
  };
}

const failed = (message: string, cause: unknown) =>
  err(domainError("INFRA_FAILURE", message, cause));

export class DrizzleStagedCorpusReader implements IStagedCorpusReader {
  private readonly db: RedlineDb;

  constructor(database: unknown) {
    this.db = database as RedlineDb;
  }

  async listCorpora(): Promise<Result<readonly StagedCorpus[]>> {
    try {
      const corpora = await this.db
        .select<StagedCorpus>(CORPUS_COLUMNS)
        .from(redlineChunks)
        .groupBy(redlineChunks.evaluationId)
        .orderBy(asc(redlineChunks.evaluationId));

      return ok(corpora);
    } catch (cause) {
      return failed("cannot list staged corpora", cause);
    }
  }

  async listDocuments(corpusId: string): Promise<Result<readonly StagedDocument[]>> {
    const counted = await this.countChunksPerDocument(corpusId);
    if (counted.error) return counted;

    if (counted.data.length === 0) {
      return err(domainError("NOT_FOUND", `no corpus staged under ${corpusId}`));
    }

    const previews = await this.readPreviews(corpusId);
    if (previews.error) return previews;

    return ok(
      counted.data.map((document) => ({
        documentId: document.documentId,
        chunkCount: document.chunkCount,
        preview: previews.data.get(document.documentId) ?? "",
      })),
    );
  }

  private async countChunksPerDocument(
    corpusId: string,
  ): Promise<Result<readonly { documentId: string; chunkCount: number }[]>> {
    try {
      const documents = await this.db
        .select<{ documentId: string; chunkCount: number }>(DOCUMENT_COLUMNS)
        .from(redlineChunks)
        .where(eq(redlineChunks.evaluationId, corpusId))
        .groupBy(redlineChunks.sourceHash)
        .orderBy(asc(redlineChunks.sourceHash));

      return ok(documents);
    } catch (cause) {
      return failed(`cannot list the documents staged under ${corpusId}`, cause);
    }
  }

  private async readPreviews(corpusId: string): Promise<Result<ReadonlyMap<string, string>>> {
    try {
      const rows = await this.db
        .select<{ documentId: string; text: string }>(PREVIEW_COLUMNS)
        .from(redlineChunks)
        .where(
          and(
            eq(redlineChunks.evaluationId, corpusId),
            eq(redlineChunks.chunkIndex, FIRST_CHUNK_INDEX),
          ),
        )
        .orderBy(asc(redlineChunks.sourceHash));

      return ok(new Map(rows.map((row) => [row.documentId, row.text.slice(0, PREVIEW_LIMIT)])));
    } catch (cause) {
      return failed(`cannot read document previews for ${corpusId}`, cause);
    }
  }
}
