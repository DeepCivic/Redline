import {
  domainError,
  err,
  isErr,
  ok,
  type EntityFilter,
  type IChunkStore,
  type IGraphStore,
  type IMoneySpanStore,
  type IProcurementExtractionReader,
  type MoneySpanFilter,
  type Result,
  type StructureFilter,
} from "@redline/redline-domain";
import { z } from "zod";

// The report tool surface. The deterministic read ports — exact fetch by key,
// structural fetch by provenance — plus graph traversal, described so a
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
// **The surface is built to its full shape, not to whatever is currently switched
// on** (architecture §5 invariant 7). Graph traversal is on the surface even
// though enrich is Isaacus spend that may not have run: whether a graph exists is a
// *runtime* condition, not a build-time one. A traversal tool whose evaluation has
// no graph loaded returns an explicit `graphAvailable: false` rather than being
// dropped, so the assembler reports what it could not reach instead of writing a
// section anyway or mistaking an empty match for an absent graph.
//
// `IChunkStore.findSimilar` is the one thing deliberately absent: it refuses with
// NOT_IMPLEMENTED until the pgvector/ANN index lands, so the assembler cannot
// search for a relevant passage — it transfers facts it is pointed at, and the
// pointing is done by classification and by the graph. And nothing here totals,
// converts or aligns money: a financial expression reaches the assembler with its
// magnitude, currency, value type and provenance, exactly as womblex wrote it. The
// review grid's own reading of the same rows (`readDocumentMoney`) is one reading,
// and is not the shape these tools serve.

export interface ReportToolDependencies {
  readonly chunkStore: IChunkStore;
  readonly moneySpanStore: IMoneySpanStore;
  readonly extractionReader: IProcurementExtractionReader;
  readonly graphStore: IGraphStore;
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

const ENTITY_ID = z
  .string()
  .min(1)
  .describe(
    "A graph node id — an entity ({source_hash}:{label}:{n}), a chunk (" +
      "{source_hash}:chunk:{i}) or a document id, as it appears in an edge's sourceId/targetId.",
  );

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
      "price: `value` is an exact decimal string that already carries its magnitude suffix and " +
      "its sign, so `multiplier` and `negative` record how it was read and must never be " +
      're-applied to it. `currency` may be unresolved. `modifier` ("up to", "approximately") ' +
      "is the one qualifier left unfolded, and the `rangeGroup`/`rangeRole` pair links a range's " +
      "two endpoints — two rows for one amount. Nothing is totalled, converted or attached to a " +
      "requirement — that reading is yours to make.",
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

// Whether the evaluation has any enrichment graph loaded at all. enrich is Isaacus
// spend that may not have run, so an empty traversal result is ambiguous: it could
// be a legitimate empty match over a real graph, or no graph at all. This probe
// disambiguates the two so a tool can report `graphAvailable: false` for the
// runtime-absent case rather than letting the assembler mistake it for "nothing
// matched". Only consulted when the direct result is empty — a non-empty result
// already proves the graph is there — and asked through `hasEntities`, which the
// store answers bounded; the question is existence, and reading the evaluation's
// entity rows to count them is exactly the unbounded read MAX_TOOL_ROWS caps.
//
// A failed probe reports unavailable rather than failing the call: the traversal
// itself already succeeded, so only the availability claim is lost.
const probeGraphAvailable = async (
  graphStore: IGraphStore,
  evaluationId: string,
): Promise<boolean> => {
  const loaded = await graphStore.hasEntities(evaluationId);
  return !isErr(loaded) && loaded.data;
};

const buildGraphPayload = async (
  graphStore: IGraphStore,
  evaluationId: string,
  rowsKey: string,
  rows: readonly unknown[],
): Promise<ReportToolPayload> => {
  const payload = buildPayload(evaluationId, rowsKey, rows);
  const graphAvailable = rows.length > 0 || (await probeGraphAvailable(graphStore, evaluationId));
  return { ...payload, graphAvailable };
};

const graphTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  defineTool({
    name: "graph_find_entities",
    title: "Find enrichment-graph entities",
    description:
      "The entities womblex's enrichment found — people, locations, terms, external documents — " +
      "filtered by document, label and/or the chunk they fall in. Each mention carries its " +
      "`chunkIndex`, so `{documentId}:{chunkIndex}` is the chunk id you then pass to fetch_chunks " +
      "to read the verbatim passage the entity was found in (chunkIndex -1 means the mention was " +
      "not mapped to a chunk). This LOCATES source rows; it is not similarity search. " +
      "`graphAvailable: false` means no enrichment graph has been loaded for this evaluation — " +
      "say so in the report rather than treating it as an empty finding.",
    inputShape: {
      evaluationId: EVALUATION_ID,
      documentId: DOCUMENT_ID.optional(),
      entityLabel: z
        .string()
        .min(1)
        .optional()
        .describe('womblex\'s label, e.g. "person", "location", "term", "external_document".'),
      chunkIndex: z
        .number()
        .int()
        .optional()
        .describe("The 0-based chunk index a mention falls in — the reverse lookup from a chunk."),
    },
    run: async (args) => {
      const filter: EntityFilter = {
        ...(args.documentId === undefined ? {} : { documentId: args.documentId }),
        ...(args.entityLabel === undefined ? {} : { entityLabel: args.entityLabel }),
        ...(args.chunkIndex === undefined ? {} : { chunkIndex: args.chunkIndex }),
      };
      const rows = await dependencies.graphStore.fetchEntities(args.evaluationId, filter);
      if (isErr(rows)) return rows;
      return ok(
        await buildGraphPayload(dependencies.graphStore, args.evaluationId, "entities", rows.data),
      );
    },
  }),
  defineTool({
    name: "graph_edges_from",
    title: "Follow edges out of a node",
    description:
      "The directed edges leaving a node (its sourceId) — the out-step of a traversal. Follow an " +
      "entity's `mentioned_in` edge to reach the chunk it names, then fetch_chunks that chunk id " +
      "for the verbatim text. Edges are ordered by (targetId, relation, propKey); a property-less " +
      "edge has empty propKey/propValue and a multi-property edge repeats across rows. " +
      "`graphAvailable: false` means no graph is loaded.",
    inputShape: { evaluationId: EVALUATION_ID, entityId: ENTITY_ID },
    run: async (args) => {
      const rows = await dependencies.graphStore.fetchEdgesFrom(args.evaluationId, args.entityId);
      if (isErr(rows)) return rows;
      return ok(
        await buildGraphPayload(dependencies.graphStore, args.evaluationId, "edges", rows.data),
      );
    },
  }),
  defineTool({
    name: "graph_edges_to",
    title: "Follow edges into a node",
    description:
      "The directed edges arriving at a node (its targetId) — the in-step of a traversal. Given a " +
      "chunk id, this finds every entity mentioned in it; given an entity, what relates to it. " +
      "Same stable order and same `graphAvailable` semantics as graph_edges_from.",
    inputShape: { evaluationId: EVALUATION_ID, entityId: ENTITY_ID },
    run: async (args) => {
      const rows = await dependencies.graphStore.fetchEdgesTo(args.evaluationId, args.entityId);
      if (isErr(rows)) return rows;
      return ok(
        await buildGraphPayload(dependencies.graphStore, args.evaluationId, "edges", rows.data),
      );
    },
  }),
];

export const buildReportTools = (dependencies: ReportToolDependencies): readonly ReportTool[] => [
  ...chunkTools(dependencies),
  ...moneySpanTools(dependencies),
  ...extractionTools(dependencies),
  ...graphTools(dependencies),
];
