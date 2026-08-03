import type { HardRule } from "../entities/hard-rule";
import type { Topic } from "../entities/topic";
import type { Result } from "../result";

// The write half of the lens seam. `IClassificationLensReader` resolves the lens
// an evaluation classifies against; something has to put one there first, and
// until this port existed nothing in the tree could — every lens row was
// operator-seeded SQL, so `readLens` returned NOT_FOUND for every evaluation and
// classification could not run at all.
//
// This is deliberately NOT the lens-authoring surface (deferred): no editing, no
// versioning, no durable-asset lifecycle. It is the minimum that lets a corpus
// driver seed the lens it is about to classify against, and the authoring work
// will layer over it rather than replace it.

// A whole lens, written in one call. The lens, its topics, its hard rules and
// its evaluation binding are one unit — a half-written lens is a lens the reader
// would reject — so they are saved together rather than through four calls.
export interface ClassificationLensDefinition {
  readonly lensId: string;
  readonly name: string;
  // The evaluation this lens is bound to. One lens per evaluation, so a save
  // rebinds rather than adding a second binding.
  readonly evaluationId: string;
  // Array order IS the stored order — the caller never supplies a position.
  // The reader returns topics in this order, so the two ports agree by
  // construction rather than by the caller numbering things consistently.
  readonly topics: readonly Topic[];
  // Likewise array order is declaration order, which is load-bearing: it is the
  // tie-break between two rules of equal specificity (ADR-0011).
  readonly rules: readonly HardRule[];
}

export interface IClassificationLensWriter {
  // Idempotent per lens: saving a lens that already exists replaces its topics
  // and rules and rebinds the evaluation. A seeding driver is re-run routinely,
  // and re-running it must not collide with the one-lens-per-evaluation index.
  saveLens(definition: ClassificationLensDefinition): Promise<Result<void>>;
}
