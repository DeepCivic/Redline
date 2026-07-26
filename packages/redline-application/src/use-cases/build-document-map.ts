import type { ComprehensionBucket } from "@redline/redline-domain";

// BuildDocumentMap — the lens's Document Map read model (design doc §2 step 2
// "Map the corpus", §3). It is a *derived, never-stored* view: how the corpus
// sorted across topics, as counts and shares, plus the corpus-wide
// Clear/Ambiguous split. Nothing here persists — it is a pure function over the
// classification the first-pass path (Threads 21/22/23) produced and the buckets
// Thread 24 derived, recomputed on demand (design doc §6: "Derived, never
// stored").
//
// It reuses `computePivot`'s *algorithm*, not its *types* (Thread 13's
// precedent): a count roll-up with first-appearance-distinct groups ranked by
// descending count, ties broken alphabetically — the deterministic shape
// `computePivot` gives a count measure — over redline's own `MappedDocument`.
// The parity assertion against the real `computePivot` lives in the adapters'
// `wayfinder-contract.test.ts`, the one package CLAUDE.md lets reach Wayfinder;
// this module imports nothing from `@rbrasier/*` (application-tier rule).
//
// No confidence value enters or escapes (non-goal §8): a `MappedDocument`
// carries a bucket, not a score, so the map is counts and shares only.

// One classified document as the map reads it: the document, the topic the
// classifier assigned it to (null when the document was left unassigned —
// nothing claimed it, or it is a collision the user has not resolved), and the
// Clear/Ambiguous bucket Thread 24 derived.
export interface MappedDocument {
  readonly documentId: string;
  readonly topicId: string | null;
  readonly bucket: ComprehensionBucket;
}

// One topic's slice of the corpus: how many documents landed on it and what
// share of the whole corpus that is.
export interface DocumentMapEntry {
  readonly topicId: string;
  readonly count: number;
  readonly percentage: number;
}

// The derived map. Per-topic entries (ranked), plus the corpus-wide roll-ups:
// assigned vs unassigned, and Clear vs Ambiguous. Every share is a percentage of
// `totalDocuments`; all zero for an empty corpus (no division by zero).
export interface DocumentMap {
  readonly totalDocuments: number;
  readonly entries: readonly DocumentMapEntry[];
  readonly assignedDocuments: number;
  readonly unassignedDocuments: number;
  readonly unassignedPercentage: number;
  readonly clearDocuments: number;
  readonly ambiguousDocuments: number;
  readonly clearPercentage: number;
  readonly ambiguousPercentage: number;
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);

// Distinct topic ids in first-appearance order — `computePivot`'s
// `distinctValues`, over the assigned documents only.
const distinctTopics = (documents: readonly MappedDocument[]): readonly string[] => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const document of documents) {
    if (document.topicId === null || seen.has(document.topicId)) continue;
    seen.add(document.topicId);
    order.push(document.topicId);
  }
  return order;
};

// Rank by descending count, alphabetical tiebreak — `computePivot`'s
// `rankByTotal`, so the map and a pivot over the same data agree on order.
const rankByCount = (
  entries: readonly DocumentMapEntry[],
): readonly DocumentMapEntry[] =>
  [...entries].sort((first, second) => {
    const difference = second.count - first.count;
    if (difference !== 0) return difference;
    if (first.topicId < second.topicId) return -1;
    if (first.topicId > second.topicId) return 1;
    return 0;
  });

export const buildDocumentMap = (documents: readonly MappedDocument[]): DocumentMap => {
  const totalDocuments = documents.length;
  const assigned = documents.filter((document) => document.topicId !== null);
  const clearDocuments = documents.filter((document) => document.bucket === "clear").length;
  const ambiguousDocuments = totalDocuments - clearDocuments;
  const unassignedDocuments = totalDocuments - assigned.length;

  const entries = distinctTopics(documents).map((topicId) => {
    const count = assigned.filter((document) => document.topicId === topicId).length;
    return { topicId, count, percentage: share(count, totalDocuments) };
  });

  return {
    totalDocuments,
    entries: rankByCount(entries),
    assignedDocuments: assigned.length,
    unassignedDocuments,
    unassignedPercentage: share(unassignedDocuments, totalDocuments),
    clearDocuments,
    ambiguousDocuments,
    clearPercentage: share(clearDocuments, totalDocuments),
    ambiguousPercentage: share(ambiguousDocuments, totalDocuments),
  };
};
