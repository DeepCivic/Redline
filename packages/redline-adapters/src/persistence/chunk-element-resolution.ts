import type { ChunkRow, MoneySpanRow } from "@redline/redline-domain";

// Chunk element addressing (delivery-plan §2.1): resolves a money span to the
// single chunk whose element range contains it, rather than to its whole
// document. Pure — no store, no I/O — so a caller (the report tool, a future
// domain use case) supplies the candidate chunks it already fetched (typically
// via IChunkStore.fetchByStructure({ documentId })).
//
// womblex addresses each locus differently (services/womblex/store/money_output.py
// / process/money_stage.py), and chunks join by a different key per content type
// (services/womblex/store/output.py CHUNKS_SCHEMA docstring), so the match rule
// mirrors that split rather than a single shared predicate:
//   narrative   — startChar/endChar overlap, the same reassemble_narrative
//                 coordinate space both the span and the chunk were cut from.
//   table_cell  — parentElementOrder (the table element) equals the chunk's
//                 elementOrder — the only anchor a table chunk carries.
//   sheet_cell  — has no chunk-side anchor to resolve against. A spreadsheet
//                 sheet has no single table element, so collect_tables_from_elements
//                 leaves every sheet chunk's elementOrder null; the span's own
//                 elementOrder (its individual cell) has nothing to match. This
//                 always returns null for a sheet_cell span until womblex gives
//                 sheet chunks an anchor of their own — a data gap, not a bug here.
export const resolveChunkForMoneySpan = (
  moneySpan: MoneySpanRow,
  chunks: readonly ChunkRow[],
): ChunkRow | null => {
  if (moneySpan.locus === "narrative") {
    return resolveByOffsetOverlap(moneySpan, chunks);
  }
  if (moneySpan.locus === "table_cell") {
    return resolveByElementOrder(moneySpan, chunks);
  }
  return null;
};

const isNumber = (value: number | null | undefined): value is number =>
  typeof value === "number";

const resolveByOffsetOverlap = (
  moneySpan: MoneySpanRow,
  chunks: readonly ChunkRow[],
): ChunkRow | null => {
  const { startChar, endChar } = moneySpan;
  if (startChar === null || endChar === null) return null;

  const containing = chunks.find(
    (chunk) =>
      chunk.contentType === "narrative" &&
      isNumber(chunk.startChar) &&
      isNumber(chunk.endChar) &&
      chunk.startChar <= startChar &&
      endChar <= chunk.endChar,
  );
  return containing ?? null;
};

const resolveByElementOrder = (
  moneySpan: MoneySpanRow,
  chunks: readonly ChunkRow[],
): ChunkRow | null => {
  const { parentElementOrder } = moneySpan;
  if (parentElementOrder === null) return null;

  const cutFromSameElement = chunks.find(
    (chunk) => chunk.contentType === "table" && chunk.elementOrder === parentElementOrder,
  );
  return cutFromSameElement ?? null;
};
