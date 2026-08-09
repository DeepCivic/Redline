import {
  domainError,
  err,
  isErr,
  ok,
  type IChunkStore,
  type IMoneySpanStore,
  type IProcurementExtractionReader,
  type MoneySpanFilter,
  type Result,
  type StructureFilter,
} from "@redline/redline-domain";
import { z } from "zod";

// The report tool surface — seven existing read ports, described so a
// report-assembler LLM can call them, and nothing else.
//
// Why these are hand-built rather than a generic SQL tool over the same rows: the
// ports encode a contract a `SELECT` does not. Ordering is stable, so a report
// assembled twice is the same report. Chunk text is verbatim — byte-identical,
// copied into report slots, never paraphrased — and the projection is the domain
// row, so `redline_chunks.embedding` is never selected (one `SELECT *` at the
// measured ~90k chunks would drag every vector across). Provenance rides on every
// row, which is the claim redline sells; it must not route through a tool that
// cannot guarantee it.
//
// Two ports are deliberately absent from this surface. `IChunkStore.findSimilar`
// refuses with NOT_IMPLEMENTED until the pgvector/ANN index lands, so the assembler
// cannot search for a relevant passage — it transfers facts it is pointed at, and
// the pointing is done by classification. And nothing here totals, converts or
// aligns money: a financial expression reaches the assembler with its magnitude,
// currency, value type and provenance, exactly as womblex wrote it. The review
// grid's own reading of the same rows (`readDocumentMoney`) is one reading, and is
// not the shape these tools serve.

export interface ReportToolDependencies {
  readonly chunkStore: IChunkStore;
  readonly moneySpanStore: IMoneySpanStore;
  readonly extractionReader: IProcurementExtractionReader;
}

// Every payload states what it returned against what matched, so a capped read is
// visible to the caller instead of looking like the whole answer.
export interface ReportToolPayload {
  readonly evaluationId: string;
  readonly returned: number;
  readonly available: number;
  readonly truncated: boolean;
  readonly [rows: string]: unknown;
}

export interface ReportTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: z.ZodRawShape;
  readonly call: (args: unknown) => Promise<Result<ReportToolPayload>>;
}

// A hard row cap on what any one tool call hands back. The ports themselves are
// unbounded and the store is happy to answer; the constraint is the assembler's
// context, where a whole document's chunks is a very expensive mistake. Capping
// deterministically (the ports order stably) keeps two identical calls identical.
export const MAX_TOOL_ROWS = 500;

const EVALUATION_ID = z
  .string()
  .min(1)
  .describe("The redline evaluation the rows belong to. Every read is scoped to one.");

const DOCUMENT_ID = z.string().min(1).describe("The document's womblex source_hash.");

const buildPayload = (
  evaluationId: string,
  rowsKey: string,
  rows: readonly unknown[],
): ReportToolPayload => {
  const returned = rows.slice(0, MAX_TOOL_ROWS);
  return {
    evaluationId,
    returned: returned.length,
    available: rows.length,
    truncated: rows.length > returned.length,
    [rowsKey]: returned,
  };
};

const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

interface ToolSpec<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: Shape;
  readonly run: (args: z.infer<z.ZodObject<Shape>>) => Promise<Result<ReportToolPayload>>;
}

// Validates in the tool rather than trusting the transport: the same descriptor is
// unit-tested without an MCP client, and a malformed call fails as a DomainError
// instead of throwing across the boundary.
const defineTool = <Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ReportTool => ({
  name: spec.name,
  title: spec.title,
  description: spec.description,
  inputShape: spec.inputShape,
  call: async (args: unknown) => {
    const parsed = z.object(spec.inputShape).safeParse(args ?? {});
    if (!parsed.success) {
      return err(domainError("VALIDATION_FAILED", `${spec.name}: ${describeIssues(parsed.error)}`));
    }
    return spec.run(parsed.data as z.infer<z.ZodObject<Shape>>);
  },
});

const chunkTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  defineTool({
    name: "fetch_chunks",
    title: "Fetch chunks by id",
    description:
      "Exact fetch of stored chunks by their stable chunk ids ({source_hash}:{chunk_index}). " +
      "Text comes back verbatim — byte-identical to the store, safe to copy into a report slot. " +
      "Rows are returned in the order the ids were given; an id that does not resolve is simply " +
      "absent. Never returns an embedding.",
    inputShape: {
      evaluationId: EVALUATION_ID,
      chunkIds: z
        .array(z.string().min(1))
        .min(1)
        .describe("Stable chunk ids to fetch, in the order they should come back."),
    },
    run: async (args) => {
      const rows = await dependencies.chunkStore.fetchChunks(args.evaluationId, args.chunkIds);
      if (isErr(rows)) return rows;
      return ok(buildPayload(args.evaluationId, "chunks", rows.data));
    },
  }),
  defineTool({
    name: "fetch_chunks_by_structure",
    title: "Fetch chunks by provenance",
    description:
      "Structural fetch of chunks by provenance — document, womblex content type and/or page. " +
      "Every field is optional and a set field narrows the result. Rows are ordered by " +
      "(documentId, chunkIndex), so two identical calls return identical results. This is " +
      "addressing, not search: there is no similarity query on this surface.",
    inputShape: {
      evaluationId: EVALUATION_ID,
      documentId: DOCUMENT_ID.optional(),
      contentType: z
        .string()
        .min(1)
        .optional()
        .describe('womblex\'s own tag for the chunk, e.g. "narrative" or "table".'),
      page: z.number().int().optional().describe("1-based page number."),
    },
    run: async (args) => {
      const filter: StructureFilter = {
        ...(args.documentId === undefined ? {} : { documentId: args.documentId }),
        ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
        ...(args.page === undefined ? {} : { page: args.page }),
      };
      const rows = await dependencies.chunkStore.fetchByStructure(args.evaluationId, filter);
      if (isErr(rows)) return rows;
      return ok(buildPayload(args.evaluationId, "chunks", rows.data));
    },
  }),
];

const moneySpanTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  defineTool({
    name: "fetch_money_spans_by_document",
    title: "Fetch a document's financial expressions",
    description:
      "Every money span womblex found in one document, across all three loci (narrative, table " +
      "cell, sheet cell), in a stable order. A span is an anchored financial expression, not a " +
      "price: `value` is an exact decimal string, `currency` may be unresolved, and `modifier` " +
      '("up to", "approximately"), `multiplier`, `negative` and the `rangeGroup`/`rangeRole` ' +
      "pair that links a range's two endpoints are carried unfolded. Nothing is totalled, " +
      "converted or attached to a requirement — that reading is yours to make.",
    inputShape: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    run: async (args) => {
      const rows = await dependencies.moneySpanStore.fetchByDocument(
        args.evaluationId,
        args.documentId,
      );
      if (isErr(rows)) return rows;
      return ok(buildPayload(args.evaluationId, "spans", rows.data));
    },
  }),
  defineTool({
    name: "fetch_money_spans_by_structure",
    title: "Fetch financial expressions by provenance",
    description:
      "Structural fetch of money spans — document, locus, the table element a cell hangs off, " +
      "and/or resolved currency. Every field is optional and a set field narrows the result; " +
      "`parentElementOrder` only ever matches table-cell spans. Same stable order and same " +
      "uninterpreted rows as fetch_money_spans_by_document.",
    inputShape: {
      evaluationId: EVALUATION_ID,
      documentId: DOCUMENT_ID.optional(),
      locus: z
        .enum(["narrative", "table_cell", "sheet_cell"])
        .optional()
        .describe("Where in the document the amount sits."),
      parentElementOrder: z
        .number()
        .int()
        .optional()
        .describe("The womblex element order of the table a cell span hangs off."),
      currency: z.string().min(1).optional().describe('ISO currency code, e.g. "AUD".'),
    },
    run: async (args) => {
      const filter: MoneySpanFilter = {
        ...(args.documentId === undefined ? {} : { documentId: args.documentId }),
        ...(args.locus === undefined ? {} : { locus: args.locus }),
        ...(args.parentElementOrder === undefined
          ? {}
          : { parentElementOrder: args.parentElementOrder }),
        ...(args.currency === undefined ? {} : { currency: args.currency }),
      };
      const rows = await dependencies.moneySpanStore.fetchByStructure(args.evaluationId, filter);
      if (isErr(rows)) return rows;
      return ok(buildPayload(args.evaluationId, "spans", rows.data));
    },
  }),
];

const extractionTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  defineTool({
    name: "read_extraction_elements",
    title: "Read a document's extracted elements",
    description:
      "One document's womblex extraction elements — the ordered text blocks, each with its " +
      "element order and page. This is the coordinate space every provenance deep-link and " +
      "table-cell anchor cites, so it is how a passage is located in the source document.",
    inputShape: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    run: async (args) => {
      const rows = await dependencies.extractionReader.readElements(
        args.evaluationId,
        args.documentId,
      );
      if (isErr(rows)) return rows;
      return ok(buildPayload(args.evaluationId, "elements", rows.data));
    },
  }),
  defineTool({
    name: "read_extraction_chunks",
    title: "Read a document's extraction chunks",
    description:
      "One document's chunks as the extraction produced them, keyed on the stable chunk id. " +
      "Use fetch_chunks when you already hold ids and want the stored rows; use this to see " +
      "what a single document was chunked into.",
    inputShape: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    run: async (args) => {
      const rows = await dependencies.extractionReader.readChunks(
        args.evaluationId,
        args.documentId,
      );
      if (isErr(rows)) return rows;
      return ok(buildPayload(args.evaluationId, "chunks", rows.data));
    },
  }),
  defineTool({
    name: "read_extraction_table_cells",
    title: "Read a document's table cells",
    description:
      "One document's extracted table cells, each with the element order of its table, its " +
      "(rowIndex, columnIndex) anchor, its raw value as printed and whether the extraction " +
      "read it as currency. This is the grid behind a pricing schedule, before any money " +
      "annotation is applied.",
    inputShape: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    run: async (args) => {
      const rows = await dependencies.extractionReader.readTableCells(
        args.evaluationId,
        args.documentId,
      );
      if (isErr(rows)) return rows;
      return ok(buildPayload(args.evaluationId, "tableCells", rows.data));
    },
  }),
];

export const buildReportTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  ...chunkTools(dependencies),
  ...moneySpanTools(dependencies),
  ...extractionTools(dependencies),
];
