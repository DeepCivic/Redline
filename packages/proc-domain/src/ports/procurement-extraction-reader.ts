import type { Result } from "../result";

// Read-only view of a womblex extraction run. Adapters (Thread 4) implement this
// over Parquet/JSON in object storage; the domain only sees typed provenance.
// Shapes mirror womblex keys (build plan §2): source_hash, elem_order, chunk_id.

export interface ExtractionElement {
  readonly documentId: string; // womblex source_hash
  readonly elementOrder: number; // womblex elem_order
  readonly page: number | null;
  readonly text: string;
}

export interface ExtractionChunk {
  readonly chunkId: string; // "{source_hash}:{chunk_index}"
  readonly documentId: string;
  readonly text: string;
}

export interface ExtractionTableCell {
  readonly documentId: string;
  readonly elementOrder: number;
  readonly page: number | null;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rawValue: string;
  readonly isCurrency: boolean;
}

export interface IProcurementExtractionReader {
  readElements(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly ExtractionElement[]>>;

  readChunks(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly ExtractionChunk[]>>;

  readTableCells(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly ExtractionTableCell[]>>;
}
