import {
  domainError,
  err,
  isErr,
  ok,
  type IWomblexAssetReader,
  type Result,
  type ShardPage,
} from "@redline/redline-domain";
import { z } from "zod";

// The tool surface. Currently three whole-document shard reads — elements,
// chunks and table cells — each backed by the one read port, the run-scoped
// shard seam. They serve womblex's own columns verbatim; nothing here remaps a
// column or folds in a derived signal.
//
// None of these is navigable yet: there is no metadata-only entry point and no
// way to ask what a document holds without pulling its rows. The navigation and
// paginated-retrieval tools that replace them are outstanding — see
// docs/Redline-Status.md §4.

export interface ReportToolDependencies {
  readonly assetReader: IWomblexAssetReader;
}

// Every payload states what it returned against what matched, so a capped read is
// visible to the caller instead of looking like the whole answer. The counts come
// straight from the sidecar's page — the seam does the paging, not this layer.
export interface ReportToolPayload {
  readonly corpusId: string;
  readonly runId: string;
  readonly asset: string;
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

// The default page a whole-document read hands back. A caller may raise it, but a
// broad read does not return a document's every row by accident — the assembler's
// context window is the constraint, and a whole document's chunks is an expensive
// mistake to make silently.
export const DEFAULT_TOOL_LIMIT = 500;

const CORPUS_ID = z
  .string()
  .min(1)
  .describe("The corpus the run belongs to. Every read is scoped to one corpus and run.");

const RUN_ID = z
  .string()
  .min(1)
  .describe("The womblex run to read. Runs co-exist under one corpus; a read names exactly one.");

const DOCUMENT_ID = z.string().min(1).describe("The document's womblex source_hash.");

const LIMIT = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(`Rows to return. Defaults to ${DEFAULT_TOOL_LIMIT}.`);

const OFFSET = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Rows to skip — the page cursor, distinct from any page column a shard carries.");

const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

interface ToolSpec<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: Shape;
  readonly run: (args: z.infer<z.ZodObject<Shape>>) => Promise<Result<ReportToolPayload>>;
}

interface DocumentShardArgs {
  readonly corpusId: string;
  readonly runId: string;
  readonly documentId: string;
  readonly limit?: number;
  readonly offset?: number;
}

const readDocumentShard = async (
  reader: IWomblexAssetReader,
  asset: string,
  rowsKey: string,
  args: DocumentShardArgs,
): Promise<Result<ReportToolPayload>> => {
  const page = await reader.readShard({
    corpusId: args.corpusId,
    runId: args.runId,
    asset,
    documentId: args.documentId,
    limit: args.limit ?? DEFAULT_TOOL_LIMIT,
    offset: args.offset ?? 0,
  });
  if (isErr(page)) return page;
  const data: ShardPage = page.data;
  return ok({
    corpusId: args.corpusId,
    runId: data.runId,
    asset: data.asset,
    returned: data.returned,
    available: data.available,
    truncated: data.truncated,
    [rowsKey]: data.rows,
  });
};

const DOCUMENT_SHARD_SHAPE = {
  corpusId: CORPUS_ID,
  runId: RUN_ID,
  documentId: DOCUMENT_ID,
  limit: LIMIT,
  offset: OFFSET,
} as const;

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
      "One document's womblex extraction elements — the ordered text blocks in their own " +
      "columns (source_hash, elem_order, page, kind, text), verbatim. This is the coordinate " +
      "space every provenance anchor cites, so it is how a passage is located in the source " +
      "document. Paginated; a broad read returns a page, not the whole document.",
    inputShape: DOCUMENT_SHARD_SHAPE,
    run: (args) => readDocumentShard(dependencies.assetReader, "elements", "elements", args),
  }),
  defineTool({
    name: "read_extraction_chunks",
    title: "Read a document's extraction chunks",
    description:
      "One document's chunks as the extraction produced them, in womblex's own columns " +
      "(source_hash, chunk_index, text, …). Text comes back verbatim — byte-identical to the " +
      "extraction, safe to copy into a report slot. Paginated.",
    inputShape: DOCUMENT_SHARD_SHAPE,
    run: (args) => readDocumentShard(dependencies.assetReader, "chunks", "chunks", args),
  }),
  defineTool({
    name: "read_extraction_table_cells",
    title: "Read a document's table cells",
    description:
      "One document's extracted table cells in womblex's own columns (source_hash, " +
      "parent_elem_order, row, col, value, …), verbatim. This is the grid behind a pricing " +
      "schedule. There is no currency column: any currency signal is derived and, where " +
      "reported, is labelled as derived rather than folded in here. Paginated.",
    inputShape: DOCUMENT_SHARD_SHAPE,
    run: (args) =>
      readDocumentShard(dependencies.assetReader, "table_cells", "tableCells", args),
  }),
];

export const buildReportTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  ...extractionTools(dependencies),
];
