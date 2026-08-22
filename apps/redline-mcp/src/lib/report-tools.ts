import {
  domainError,
  err,
  isErr,
  ok,
  type IWomblexAssetReader,
  type Result,
  type ShardPage,
  type ShardRow,
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

// The document list is navigation, so it pages in documents rather than rows. A
// client scans, narrows, then retrieves; it does not need the whole run at once.
export const DEFAULT_DOCUMENT_LIMIT = 25;

// Entity names are an unbounded list in their own right — one small document in the
// throsby fixture carries 34 entity rows — so they are capped per document,
// separately from the document page, and carry their own counts. Distinct names run
// well below the row count (12 for that document), so the cap is sized against a
// wide run, not against what one document happens to mention.
export const DEFAULT_ENTITY_NAME_LIMIT = 20;

// The seam serves every matching row under a negative limit. list_documents filters
// and pages above the seam, so it has to see the run's whole metadata set before it
// can say honestly what it withheld. Only the metadata shards are read this way —
// none of them carries document body.
const WHOLE_ASSET = -1;

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

const EXACT_MATCH = (column: string) =>
  z.string().min(1).optional().describe(`Exact match on \`${column}\`. Not a text search.`);

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


// The two identity spellings carry the same value: the enrichment and graph shards
// key on `document_id`, every other family on `source_hash`. Read both, so a join
// does not silently return nothing on a corpus that uses the other spelling.
const identityOf = (row: ShardRow): string | undefined => {
  const identity = row.document_id ?? row.source_hash;
  return typeof identity === "string" ? identity : undefined;
};

const groupByDocument = (rows: readonly ShardRow[]): Map<string, ShardRow[]> => {
  const grouped = new Map<string, ShardRow[]>();
  for (const row of rows) {
    const identity = identityOf(row);
    if (identity === undefined) continue;
    const existing = grouped.get(identity);
    if (existing) existing.push(row);
    else grouped.set(identity, [row]);
  }
  return grouped;
};

const distinctNames = (rows: readonly ShardRow[]): string[] => {
  const names = rows.map((row) => row.name).filter((name): name is string => typeof name === "string");
  return [...new Set(names)];
};

// Only the three enrichment columns this tool serves, verbatim. The rest of
// ENRICHMENT_META_SCHEMA (the per-label counts) is not part of the document list.
const enrichmentOf = (row: ShardRow | undefined): Record<string, unknown> | null => {
  if (row === undefined) return null;
  return {
    title: row.title,
    doc_type_enriched: row.doc_type_enriched,
    jurisdiction: row.jurisdiction,
  };
};

interface DocumentSummary {
  readonly manifest: ShardRow;
  readonly enrichment: Record<string, unknown> | null;
  readonly entityNames: readonly string[];
}

interface ListDocumentsArgs {
  readonly corpusId: string;
  readonly runId: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: string;
  readonly ext?: string;
  readonly docTypeEnriched?: string;
  readonly jurisdiction?: string;
  readonly entityName?: string;
}

const matchesFilters = (summary: DocumentSummary, args: ListDocumentsArgs): boolean => {
  if (args.status !== undefined && summary.manifest.status !== args.status) return false;
  if (args.ext !== undefined && summary.manifest.ext !== args.ext) return false;
  if (args.jurisdiction !== undefined && summary.enrichment?.jurisdiction !== args.jurisdiction) {
    return false;
  }
  if (
    args.docTypeEnriched !== undefined &&
    summary.enrichment?.doc_type_enriched !== args.docTypeEnriched
  ) {
    return false;
  }
  // Matched against the document's full distinct set, before the cap below, so a
  // capped list can never hide a document that actually matched.
  return args.entityName === undefined || summary.entityNames.includes(args.entityName);
};

const asPayloadDocument = (summary: DocumentSummary): Record<string, unknown> => {
  const names = summary.entityNames.slice(0, DEFAULT_ENTITY_NAME_LIMIT);
  return {
    ...summary.manifest,
    enrichment: summary.enrichment,
    entity_names: {
      names,
      returned: names.length,
      available: summary.entityNames.length,
      truncated: names.length < summary.entityNames.length,
    },
  };
};

const listDocuments = async (
  reader: IWomblexAssetReader,
  args: ListDocumentsArgs,
): Promise<Result<ReportToolPayload>> => {
  const wholeAsset = (asset: string) =>
    reader.readShard({ corpusId: args.corpusId, runId: args.runId, asset, limit: WHOLE_ASSET });

  const [manifest, enrichment, entities] = await Promise.all([
    wholeAsset("manifest"),
    wholeAsset("enrichment_meta"),
    wholeAsset("entities"),
  ]);
  if (isErr(manifest)) return manifest;
  if (isErr(enrichment)) return enrichment;
  if (isErr(entities)) return entities;

  const enrichmentByDocument = groupByDocument(enrichment.data.rows);
  const entitiesByDocument = groupByDocument(entities.data.rows);
  // A manifest row carrying neither identity spelling joins to nothing rather than
  // to every other such row: an empty key would pool them together.
  const summaries = manifest.data.rows.map((row) => {
    const identity = identityOf(row);
    if (identity === undefined) return { manifest: row, enrichment: null, entityNames: [] };
    return {
      manifest: row,
      enrichment: enrichmentOf(enrichmentByDocument.get(identity)?.[0]),
      entityNames: distinctNames(entitiesByDocument.get(identity) ?? []),
    };
  });

  const matching = summaries.filter((summary) => matchesFilters(summary, args));
  const offset = args.offset ?? 0;
  const window = matching.slice(offset, offset + (args.limit ?? DEFAULT_DOCUMENT_LIMIT));
  return ok({
    corpusId: args.corpusId,
    runId: manifest.data.runId,
    asset: "manifest",
    returned: window.length,
    // enrichment_meta and entities are joined onto the manifest, never appended to
    // it: the document count is the manifest's, whatever the other two hold.

    available: matching.length,
    truncated: offset + window.length < matching.length,
    documents: window.map(asPayloadDocument),
  });
};

const navigationTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  defineTool({
    name: "list_documents",
    title: "List a run's documents",
    description:
      "Every document in one womblex run, as metadata only — no document text at all. This is " +
      "the entry point: it is how a client decides which documents are worth opening, without " +
      "opening any of them. Each document carries the manifest's own columns verbatim " +
      "(source_hash, doc_id, filename, ext, status and the element / table-cell / form-field " +
      "counts), plus `enrichment` (title, doc_type_enriched, jurisdiction — null where the " +
      "enrich stage did not run) and `entity_names`, the distinct entity names womblex " +
      "extracted, capped with their own returned/available/truncated. Filtering is exact match " +
      "on a metadata value; there is no text search over document bodies. Paginated in " +
      `documents, defaulting to ${DEFAULT_DOCUMENT_LIMIT}.`,
    inputShape: {
      corpusId: CORPUS_ID,
      runId: RUN_ID,
      limit: LIMIT,
      offset: OFFSET,
      status: EXACT_MATCH("status"),
      ext: EXACT_MATCH("ext"),
      docTypeEnriched: EXACT_MATCH("doc_type_enriched"),
      jurisdiction: EXACT_MATCH("jurisdiction"),
      entityName: EXACT_MATCH("name"),
    },
    run: (args) => listDocuments(dependencies.assetReader, args),
  }),
];

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
  ...navigationTools(dependencies),
  ...extractionTools(dependencies),
];
