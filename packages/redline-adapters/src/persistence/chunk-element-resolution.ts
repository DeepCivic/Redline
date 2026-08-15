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
//   narrative   — the chunk whose offset range *contains* the span. Containment,
//                 not mere overlap: a span straddling a boundary belongs to
//                 neither chunk cleanly, and naming one of them would put a
//                 figure in a context that does not hold all of it. Both sides
//                 are offsets into the reassembled narrative, which share a
//                 coordinate space only within one text_source layer — womblex
//                 applies the overlay before reassembly at both the chunk and
//                 money sites off one `config.text_source`, so a single run
//                 agrees. Spans re-run under a different layer are not
//                 comparable, and nothing on ChunkRow can detect that.
//   table_cell  — parentElementOrder (the table element) equals the chunk's
//                 elementOrder — the only anchor a table chunk carries.
//   sheet_cell  — has no chunk-side anchor to resolve against. A spreadsheet
//                 sheet has no single table element, so collect_tables_from_elements
//                 leaves every sheet chunk's elementOrder null; the span's own
//                 elementOrder (its individual cell) has nothing to match. This
//                 always returns null for a sheet_cell span until womblex gives
//                 sheet chunks an anchor of their own — a data gap, not a bug here.
//
// Every match is scoped to the span's own documentId first. Offsets and element
// orders are per-document sequences, so document B's chunk 0..200 would "contain"
// document A's span at 120 on the numbers alone; a caller that fetched more
// broadly than one document would otherwise get a confidently wrong provenance
// anchor, which is worse than none.
export const resolveChunkForMoneySpan = (
  moneySpan: MoneySpanRow,
  chunks: readonly ChunkRow[],
): ChunkRow | null => {
  const sameDocument = chunks.filter((chunk) => chunk.documentId === moneySpan.documentId);
  if (moneySpan.locus === "narrative") {
    return resolveByOffsetContainment(moneySpan, sameDocument);
  }
  if (moneySpan.locus === "table_cell") {
    return resolveByElementOrder(moneySpan, sameDocument);
  }
  return null;
};

// Overlapping chunks are legitimate — semchunk takes an `overlap` for narratives
// — so more than one chunk can contain a span. The first match wins, which is
// stable because the store orders by (documentId, chunkIndex).
const resolveByOffsetContainment = (
  moneySpan: MoneySpanRow,
  chunks: readonly ChunkRow[],
): ChunkRow | null => {
  const { startChar, endChar } = moneySpan;
  if (startChar === null || endChar === null) return null;

  const containing = chunks.find(
    (chunk) =>
      chunk.contentType === "narrative" &&
      chunk.startChar !== null &&
      chunk.endChar !== null &&
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
