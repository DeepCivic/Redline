import type { Result } from "../result";
import type { ShardColumn } from "./womblex-asset-reader";

// How big a corpus, run or document is — read without reading the rows.
//
// This is the port a client sizes a retrieval through. Choosing a page size is a
// judgement about the *caller's* budget: how much context window it has left, and
// whether it is reading one document deeply or twenty shallowly. Redline knows
// neither, so it reports size and lets the caller decide, rather than guessing on
// the caller's behalf with a default.
//
// Everything here is **derived** — aggregate metadata about rows, not rows. It is
// the one place in redline's read surface where a value is computed rather than
// carried, so it is kept on its own port, under its own keys, and never mixed in
// among womblex's columns. The verbatim seam is `IWomblexAssetReader`; nothing
// here substitutes for it.

// One distinct value of a tallied column, and how many rows carry it. `value` is
// verbatim — womblex's own label — while `rows` is derived.
export interface ShapeTallyValue {
  readonly value: unknown;
  readonly rows: number;
}

// A tallied column: which values a document holds and how common each is. Capped,
// so `distinct` and `truncated` say what the counts withheld.
export interface ShapeTally {
  readonly counts: readonly ShapeTallyValue[];
  readonly distinct: number;
  readonly truncated: boolean;
}

// A column answered by its bounds rather than its distinct values — a printed
// page range narrows a retrieval the way a tally cannot.
export interface ShapeRange {
  readonly min: unknown;
  readonly max: unknown;
}

// One shard family's size within one run.
//
// `rows` is `null` only for an asset redline refuses to serve: `present` already
// says the run holds it, and a count would be redline answering about rows it will
// not hand over. `columns` is empty at corpus scope, where twelve assets' schemas
// are weight against a question nobody asked.
export interface AssetShape {
  readonly name: string;
  readonly present: boolean;
  readonly readable: boolean;
  readonly rows: number | null;
  readonly columns: readonly ShardColumn[];
  readonly values: Readonly<Record<string, ShapeTally>>;
  readonly ranges: Readonly<Record<string, ShapeRange>>;
}

export interface RunShape {
  readonly runId: string;
  readonly versioned: boolean;
  readonly documents: number;
  readonly assets: readonly AssetShape[];
}

// Runs are always reported separately, at every scope. Merging them would double
// every count and leave the provenance keys identifying nothing — the failure
// run-scoping exists to prevent.
//
// For the same reason `documents` is `null` at corpus scope, and deliberately. Runs of one corpus
// normally hold the same documents — a re-run is the ordinary case — so summing
// per-run counts would report a corpus of one document as two, and saying which
// are the *same* means reading every run's identity column, the cost that makes
// this call cheap enough to make first. The per-run counts are the answer.
export interface CorpusShape {
  readonly corpusId: string;
  readonly runId: string | null;
  readonly documentId: string | null;
  readonly documents: number | null;
  readonly runs: readonly RunShape[];
}

// Three scopes by narrowing: corpus alone, plus a run, plus a document. Tallies
// answer only at document scope — a tally over a whole run scales with the run,
// and the question it answers is always asked about one document.
export interface WomblexShapeRequest {
  readonly corpusId: string;
  readonly runId?: string;
  readonly documentId?: string;
}

export interface IWomblexShapeReader {
  readShape(request: WomblexShapeRequest): Promise<Result<CorpusShape>>;
}
