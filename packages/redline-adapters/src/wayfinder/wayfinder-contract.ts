// The read-only Wayfinder seam, in the one package CLAUDE.md sanctions for it.
//
// `@rbrasier/domain` is an *optional* workspace dependency (ADR-0012): the
// workspace installs, typechecks and tests with no `vendor/wayfinder` present.
// Two consequences shape this file:
//
//   1. The module is loaded at runtime, never imported statically, so a clean
//      clone does not fail to resolve it.
//   2. The shape we consume is declared locally. These interfaces are the
//      contract; wayfinder-contract.test.ts asserts the real upstream helpers
//      still satisfy it, which is how drift surfaces.

export interface WayfinderDisplayCell {
  readonly value: number | string;
  readonly isNumeric: boolean;
}

export interface WayfinderSessionRow {
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly status: string;
  readonly values: Record<string, string>;
}

export interface WayfinderPivotColumn {
  readonly columnKey: string;
  readonly label: string;
  readonly type: string;
  readonly memberKeys: string[];
}

// Upstream's measure union. redline uses `sum` for pricing (Thread 13) and
// `count` for the Document Map's per-topic tally (Thread 25); `avg` is declared
// to match `computePivot`'s real signature so the drift check exercises the
// whole shape, not a subset.
export type WayfinderPivotMeasure =
  | { readonly kind: "count" }
  | { readonly kind: "sum" | "avg"; readonly columnKey: string };

export interface WayfinderPivotOptions {
  readonly columns: readonly WayfinderPivotColumn[];
  readonly groupByKey: string;
  readonly measure: WayfinderPivotMeasure;
}

export interface WayfinderPivotCell {
  readonly value: number;
  readonly sampleCount: number;
}

export interface WayfinderPivotResult {
  readonly rows: readonly { readonly key: string; readonly total: WayfinderPivotCell }[];
  readonly grandTotal: WayfinderPivotCell;
  readonly hasNumericData: boolean;
}

export interface WayfinderDomainContract {
  readonly typedDisplayCell: (type: string, raw: string) => WayfinderDisplayCell;
  readonly typedCellValue: (type: string, raw: string) => number | string;
  readonly computePivot: (
    rows: readonly WayfinderSessionRow[],
    options: WayfinderPivotOptions,
  ) => WayfinderPivotResult;
}

// Held in a variable, not written inline: a literal specifier would make `tsc`
// resolve the module at compile time and fail on a clean clone where the
// optional dependency is absent.
const WAYFINDER_DOMAIN_SPECIFIER = "@rbrasier/domain";

// Returns null when the vendored tree is absent, so suites skip rather than
// fail. CI vendors the pinned tree and sets REQUIRE_WAYFINDER=1 — there, an
// absent tree must fail loudly, or the drift check silently stops running.
export const loadWayfinderDomain = async (): Promise<WayfinderDomainContract | null> => {
  try {
    return (await import(WAYFINDER_DOMAIN_SPECIFIER)) as unknown as WayfinderDomainContract;
  } catch (error) {
    if (process.env.REQUIRE_WAYFINDER === "1") throw error;
    return null;
  }
};

// --- The frozen contract ------------------------------------------------------
//
// Captured from rbrasier/wayfinder at the pinned commit (see wayfinder.pin).
// Every redline test that used to call a Wayfinder helper as its oracle now
// asserts against these values instead, which is what lets those suites run with
// no Wayfinder present. The drift check re-derives all of them from upstream.

export const WAYFINDER_TYPED_CELL_CONTRACT: readonly {
  readonly type: string;
  readonly raw: string;
  readonly cell: WayfinderDisplayCell;
}[] = [
  { type: "currency", raw: "1000", cell: { value: 1000, isNumeric: true } },
  { type: "currency", raw: "1200.50", cell: { value: 1200.5, isNumeric: true } },
  { type: "currency", raw: "1500.5", cell: { value: 1500.5, isNumeric: true } },
  { type: "currency", raw: "", cell: { value: "", isNumeric: false } },
  { type: "text", raw: "Acme", cell: { value: "Acme", isNumeric: false } },
];

export const WAYFINDER_TYPED_VALUE_CONTRACT: readonly {
  readonly type: string;
  readonly raw: string;
  readonly value: number | string;
}[] = [
  { type: "currency", raw: "80000", value: 80000 },
  { type: "text", raw: "component", value: "component" },
];

// The Thread 13 pricing fixture projected onto Wayfinder's row shape: three
// vendors, two requirements, one description-fallback row that carries no
// number and must not count towards the roll-up.
const pivotRows: readonly WayfinderSessionRow[] = [
  ["Acme", "1000"],
  ["Acme", "500"],
  ["Globex", "2000"],
  ["Globex", ""],
  ["Initech", "3000"],
].map(([vendorName, estimateAud], index) => ({
  sessionId: `row-${index}`,
  startedAt: new Date(0),
  status: "complete",
  values: { vendorName: vendorName!, estimateAud: estimateAud! },
}));

export const WAYFINDER_PIVOT_CONTRACT = {
  rows: pivotRows,
  columns: [
    { columnKey: "vendorName", label: "Vendor", type: "text", memberKeys: ["vendorName"] },
    {
      columnKey: "estimateAud",
      label: "Estimate (AUD)",
      type: "currency",
      memberKeys: ["estimateAud"],
    },
  ] as const satisfies readonly WayfinderPivotColumn[],
  groupByKey: "vendorName",
  measure: { kind: "sum", columnKey: "estimateAud" } as const satisfies WayfinderPivotMeasure,
  expectedRows: [
    { key: "Initech", value: 3000 },
    { key: "Globex", value: 2000 },
    { key: "Acme", value: 1500 },
  ],
  expectedGrandTotal: { value: 6500, sampleCount: 4 },
} as const;

// The Document Map (Thread 25) rolls the corpus up per topic with a *count*
// measure, ranked by descending count with an alphabetical tiebreak. Its
// `buildDocumentMap` reimplements that shape over redline's own `MappedDocument`
// (Thread 13's precedent: reuse the algorithm, not the types); this fixture
// freezes the ordering `computePivot`'s count measure produces on the same tie
// so drift in the ranking rule is caught here. Mirrors the map's tie-break test:
// topic-c (3) outranks topic-a and topic-b (2 each), and the tie resolves
// alphabetically.
const topicRows: readonly WayfinderSessionRow[] = [
  "topic-b",
  "topic-b",
  "topic-a",
  "topic-a",
  "topic-c",
  "topic-c",
  "topic-c",
].map((topicId, index) => ({
  sessionId: `doc-${index}`,
  startedAt: new Date(0),
  status: "complete",
  values: { topicId },
}));

export const WAYFINDER_COUNT_PIVOT_CONTRACT = {
  rows: topicRows,
  columns: [
    { columnKey: "topicId", label: "Topic", type: "text", memberKeys: ["topicId"] },
  ] as const satisfies readonly WayfinderPivotColumn[],
  groupByKey: "topicId",
  measure: { kind: "count" } as const satisfies WayfinderPivotMeasure,
  expectedRows: [
    { key: "topic-c", value: 3 },
    { key: "topic-a", value: 2 },
    { key: "topic-b", value: 2 },
  ],
  expectedGrandTotal: { value: 7, sampleCount: 7 },
} as const;
