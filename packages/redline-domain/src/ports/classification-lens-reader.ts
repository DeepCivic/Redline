import type { HardRuleCandidate } from "../entities/hard-rule-evaluation";
import type { HardRuleSet } from "../entities/hard-rule";
import type { Topic } from "../entities/topic";
import type { Result } from "../result";

// The evaluation-scoped classification context, read per call.
//
// `IProcurementClassifier` carries no lens: `ClassificationRequest` is
// `{ evaluationId, responseGroupId, documentIds }`, so a classifier that holds
// its lens as constructor state can only ever serve one evaluation. That is
// fatal at the seam the served UI binds at — the fork's `getContainer()` is a
// process-wide memoised singleton, so one process must serve every evaluation.
// This port is the route from an evaluation to the lens it classifies against,
// resolved inside `classifyResponseGroup` rather than at construction, which
// makes the classifier a legitimate process-lifetime singleton.
//
// `IProcurementClassifier` keeps its exact signature, so port
// interchangeability holds (D2; ADR-0008 — "consumers cannot tell which ran")
// and no consumer changes.

export interface ClassificationLensRequest {
  readonly evaluationId: string;
  // The documents about to be classified. `candidates` are derived from these
  // per call rather than stored, so the reader only does the work the request
  // needs.
  readonly documentIds: readonly string[];
}

// What a classifier needs to classify one response group: the lens's topics and
// hard rules (both evaluation-scoped, via the lens↔evaluation binding) plus the
// per-document identifier tokens the rules match on.
export interface ClassificationLens {
  // The topics adjudication chooses among, each carrying the definition the
  // model reasons over. A topic's id is the requirement's id it projects to
  // (ADR-0010).
  readonly topics: readonly Topic[];
  // The lens's hard rules, in declaration order. May be empty — then every
  // document is unclaimed and falls through to adjudication (ADR-0008).
  readonly ruleSet: HardRuleSet;
  // Derived per document from the request's `documentIds`, never stored:
  // identifier tokens only, never prose (hard rules match identifiers — a rule
  // that read body text would be a classifier).
  readonly candidates: readonly HardRuleCandidate[];
}

export interface IClassificationLensReader {
  readLens(request: ClassificationLensRequest): Promise<Result<ClassificationLens>>;
}
