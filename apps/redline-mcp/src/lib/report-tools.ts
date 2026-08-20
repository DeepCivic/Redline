import {
  domainError,
  err,
  isErr,
  ok,
  type IProcurementExtractionReader,
  type Result,
} from "@redline/redline-domain";
import { z } from "zod";

// The report tool surface. Currently the three extraction-reader reads —
// elements, chunks and table cells — described so a report-assembler LLM can
// call them. The chunk-store, money-span-store and enrichment-graph tools
// (fetch_chunks, fetch_chunks_by_structure, fetch_money_spans_by_document,
// fetch_money_spans_by_structure, graph_find_entities, graph_edges_from,
// graph_edges_to) are removed along with the ports they read — the store those
// ports queried no longer exists. See docs/Redline-Status.md for what replaces it.
//
// Why these are hand-built rather than a generic call over the same rows: the
// port encodes a contract a raw read does not. Ordering is stable, so a report
// assembled twice is the same report, and chunk text is verbatim — byte-identical,
// copied into report slots, never paraphrased.

export interface ReportToolDependencies {
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
      "Text comes back verbatim — byte-identical to the extraction, safe to copy into a report " +
      "slot.",
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
  ...extractionTools(dependencies),
];
