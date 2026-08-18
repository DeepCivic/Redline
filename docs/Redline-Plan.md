# Redline Delivery Plan — Grounded Extraction Output → CSV

## Objective

Turn a batch of **already-extracted document content** into a downloadable,
grounded CSV, where every non-empty cell is copied verbatim from — or
deterministically normalised (allowlist only) from — that extracted content. An
LLM may reason, search and select; it may not author a cell value.

## What this consumes (and what it does not)

redline reads **womblex output** — extracted content, not the womblex engine.
The engine, OCR, embeddings, and any API gating are out of scope entirely and
never appear in this loop. The output arrives from any of three sources, all of
which must be supported:

- a batch of files in a local folder,
- a batch of objects in a bucket,
- rows in a database.

Every source resolves to the same per-document shape, behind a single reader
port:

- `elements[]` — `{ documentId, elementOrder, page, text }`
- `chunks[]` — `{ chunkId, documentId, text }` (chunkId is `{documentId}:{index}`)
- `tableCells[]` — `{ documentId, elementOrder, rowIndex, columnIndex, rawValue, isCurrency }`

`documentId` is the document identity. The source is swappable behind the port;
the pipeline above it is source-agnostic.

## Core invariant

> Every non-empty CSV cell is copied verbatim from, or deterministically
> normalised (allowlist only) from, a span of extracted content that the
> verifier re-reads and matches. A value without a matching span is rejected —
> the cell is left empty and the reason recorded. When in doubt, reject.

Asserted mechanically — re-read the referenced span, compare bytes — never
eyeballed.

## What the LLM does, and does not do

The agent:
1. Reads the user's column spec (name, type, required).
2. Reads a document's extracted content through the reader port.
3. Proposes, per (row, column), a **span reference** — a document id plus the
   span it believes holds the value (an element + char range, or a table-cell
   anchor).
4. Reports "not found" for a field it cannot ground, rather than guessing.

Its output is a set of **claims requiring verification**. A claim carries a
**reference, not a bare value**: the verifier derives the value from the
referenced span, so the agent cannot inject a value it composed.

## What the verifier + assembler do (deterministic)

1. Resolve every reference against the reader.
2. Re-read the referenced span and derive the cell value from it — element text
   sliced by char range, or a table cell's `rawValue`.
3. Reject and leave empty when the reference does not resolve, the derived value
   is empty, normalisation is not allowlisted, or the value fails its column
   type. Record the reason as a `DomainError`.
4. Assemble verified row into the CSV one at a time.
5. Repeat until corpus is complete.

Note: expectation is 1 document = 1 row and a single LLM call does not do more than 1 document.

## Data contracts (minimal; in the real domain types)

```ts
export interface ColumnSpec {
  readonly name: string;
  readonly type: "string" | "currency" | "date" | "number";
  readonly required: boolean;
  readonly normalisation: "iso_date" | "decimal_currency" | "none";
}

// A claim references a span; it has NO value field.
export type SpanReference =
  | { readonly kind: "element"; readonly documentId: string; readonly elementOrder: number; readonly start: number; readonly end: number }
  | { readonly kind: "table_cell"; readonly documentId: string; readonly elementOrder: number; readonly rowIndex: number; readonly columnIndex: number };

export interface ExtractionClaim {
  readonly rowKey: string;
  readonly column: string;
  readonly reference: SpanReference;
}

export interface VerifiedCell {
  readonly rowKey: string;
  readonly column: string;
  readonly value: string | null;
  readonly verified: boolean;
  readonly rejection?: DomainError; // reuses the domain taxonomy — no new type
  readonly reference?: SpanReference;
  readonly rawText?: string;        // the exact span the value came from
}
```

CSV output = the grounded value grid: one column per `ColumnSpec`, cells either
a verified value or empty.

## The reader port and its sources

A single port returns the per-document shape above, implemented over each source:

- **folder source** — reads a batch of extracted-output files from a local dir.
- **bucket source** — reads a batch of objects from a bucket.
- **db source** — reads rows.

All three are built and proven together — the pipeline above the port cannot be
trusted until it behaves identically regardless of source. The pipeline is
tested against a **committed fixture batch** — a representative sample of
extracted output authored as data — so the verifier and assembler are proven
without any external system.

## Fixtures

A small, redline-owned batch of extracted-output records committed as data:
a handful of documents including at least one with a **table of cells** (so cell
→ CSV row and currency/number normalisation are exercised) and one prose
document (so element + char-range grounding is exercised). Authored directly to
the reader's shape — nothing runs to produce it. The same fixture batch is read
through each of the three sources so the source implementations are proven
equivalent.

## Milestones (each shippable; small diffs)

- **Step 0 — Strip to plan scope.** Delete every file in the redline repo that
  does not exist in service to this plan. The repo is mostly wrong — leftover
  from a prior direction, not something to preserve — so the strip is broad, not
  surgical. Deleting a package means also removing every dangling reference to
  it, so the workspace still resolves: its `workspace:*` dependency entries,
  `tsconfig` project references, and `Dockerfile` COPY lines. In particular
  `redline-application` and `redline-shared` are untracked build residue (stale
  `dist/` with no `src/`, nothing committed) — delete the residue and every
  reference, or recreate them with real `src/`; they must not be left half-
  present. (Blast-radius analysis is the implementing dev's job, not this
  plan's.)
- **M0 — Baseline compiles.** Make the workspace resolve again after the strip,
  and reconcile the domain and adapters `index.ts` barrels to what remains on
  disk. Green validate is earned here, not immediate: `pnpm install` cannot
  resolve while deleted packages are still referenced, so M0 is done only when
  the strip's dangling references are all cleared.
- **M1 — Contracts.** `ColumnSpec`, `SpanReference`, `ExtractionClaim`,
  `VerifiedCell` in the domain, zero-dependency, tests first.
- **M2 — Reader + all three sources + fixture batch.** The reader port and its
  folder, bucket and db implementations over a committed extracted-output batch
  (tables + prose + a currency cell), proven equivalent across sources. The
  per-document shape in this plan is the source of truth: any reader port left
  on disk after the strip is more to delete, not a contract to reconcile
  against. Build the reader to this plan's shape, keyed on `documentId` alone.
- **M3 — Verifier.** `verifyClaims(reader, spec, claims) → VerifiedCell[]`.
  Resolves references, derives values, applies allowlist normalisation, rejects
  with the right code. Proven against the fixture batch — no LLM.
- **M4 — CSV assembler.** Verified rows → CSV. Deterministic ordering.
- **M5 — Claim-producing agent.** LLM reads spec + extracted content, emits
  claims (references only). Wired to the verifier; proven with a fake model.
- **M6 — Surface it in Wayfinder (`0.23.1`).** Re-validate the mount against the
  current version and expose the CSV download. The Wayfinder fork was fast-
  forwarded, so its `apps/web` is not a fixed contract to protect: expect
  breakage in the mount and fix it in-flight — that is anticipated build work,
  not a design risk. Out of scope until M0–M5 are green.

## Acceptance criteria (automated, no external systems)

1. Fabricated reference (span does not hold the value) → empty cell, not
   verified, rejection recorded.
2. Correct reference → populated cell, verified.
3. Table-cell currency reference + `decimal_currency` → normalised value,
   verified.
4. Non-allowlisted normalisation → rejected `VALIDATION_FAILED`.
5. Unresolvable reference → rejected `NOT_FOUND`.
6. Missing required field → empty cell, reason recorded, CSV still emits.
7. The reader returns identical results for the same fixture batch across the
   folder, bucket and db sources.
8. Assembling twice over the same input yields byte-identical CSVs.

## Non-goals

- The womblex engine and everything it does — not in this loop.
- Chunk/money/graph stores, run trigger, staged-corpus writer as prerequisites —
  they return only if a CSV genuinely needs them.
- Similarity search, cross-document reconciliation, conflict resolution,
  confidence scoring — deferred; safe rejection stands in.
- A provenance companion file or appended provenance columns — out of scope; the
  CSV is the grounded value grid.
- The report/workbook assembler in the Wayfinder submodule — separate path, left
  untouched.
