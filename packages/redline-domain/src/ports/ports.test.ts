import { describe, it, expect } from "vitest";
import { isOk } from "../result";
import { ok, type Result } from "../result";
import type {
  IProcurementExtractionReader,
  ExtractionChunk,
  ExtractionElement,
  ExtractionTableCell,
} from "./procurement-extraction-reader";

// This fake exists to prove the extraction-reader port is implementable and
// shaped as its adapter needs. It is the port's spec.

class StubExtractionReader implements IProcurementExtractionReader {
  async readElements(): Promise<Result<readonly ExtractionElement[]>> {
    return ok([{ documentId: "hashA", elementOrder: 0, page: 1, text: "Acme response" }]);
  }
  async readChunks(): Promise<Result<readonly ExtractionChunk[]>> {
    return ok([{ chunkId: "hashA:0", documentId: "hashA", text: "chunk" }]);
  }
  async readTableCells(): Promise<Result<readonly ExtractionTableCell[]>> {
    return ok([
      {
        documentId: "hashA",
        elementOrder: 5,
        page: 2,
        rowIndex: 0,
        columnIndex: 1,
        rawValue: "80000",
        isCurrency: true,
      },
    ]);
  }
}

describe("port conformance (in-memory fakes)", () => {
  it("reads elements, chunks and table cells for one corpus document", async () => {
    const reader: IProcurementExtractionReader = new StubExtractionReader();

    const elements = await reader.readElements("c1", "hashA");
    const chunks = await reader.readChunks("c1", "hashA");
    const cells = await reader.readTableCells("c1", "hashA");

    expect(isOk(elements) && isOk(chunks) && isOk(cells)).toBe(true);
    if (!isOk(elements) || !isOk(chunks) || !isOk(cells)) return;
    expect(elements.data[0]?.documentId).toBe("hashA");
    expect(chunks.data[0]?.chunkId).toBe("hashA:0");
    expect(cells.data[0]?.isCurrency).toBe(true);
  });
});
