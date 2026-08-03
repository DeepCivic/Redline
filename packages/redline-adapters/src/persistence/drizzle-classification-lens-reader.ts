// DrizzleClassificationLensReader — IClassificationLensReader over the redline_
// lens tables (ADR-0009 for the shape, ADR-0020 for redline-owned definitions).
//
// It has TWO collaborators, not one, which is why the name says "Drizzle" but
// the constructor takes more than a database handle: the lens's topics and hard
// rules are persisted and read with drizzle, while `candidates` are DERIVED per
// call from the request's documentIds (see lens/hard-rule-candidate-deriver.ts).
// Storing candidates would mean invalidating them whenever a document joins an
// evaluation, so the port resolves them fresh each time.
//
// Read-only. Nothing here writes a lens — authoring one is the operator-side
// concern that lands with the evaluation write path.

import {
  domainError,
  err,
  isErr,
  makeHardRuleSet,
  ok,
  type ClassificationLens,
  type ClassificationLensRequest,
  type HardRule,
  type HardRuleSet,
  type IClassificationLensReader,
  type Result,
  type Topic,
} from "@redline/redline-domain";
import { asc, eq } from "drizzle-orm";
import type { DeriveHardRuleCandidates } from "../lens/hard-rule-candidate-deriver";
import { redlineHardRules, redlineLensBindings, redlineTopics } from "./schema";

const TOPIC_COLUMNS = {
  id: redlineTopics.id,
  name: redlineTopics.name,
  definition: redlineTopics.definition,
} as const;

const HARD_RULE_COLUMNS = {
  id: redlineHardRules.id,
  pattern: redlineHardRules.pattern,
  topicId: redlineHardRules.topicId,
} as const;

const BINDING_COLUMNS = { lensId: redlineLensBindings.lensId } as const;

// The minimal drizzle surface used, kept structural so the postgres-js and
// PGlite instances both satisfy it without a driver import — the same treatment
// DrizzleChunkStore gives its handle.
interface RedlineDb {
  select: (columns: unknown) => {
    from: (table: unknown) => {
      where: (predicate: unknown) => {
        orderBy: (...columns: unknown[]) => Promise<unknown[]>;
        limit: (count: number) => Promise<unknown[]>;
      };
    };
  };
}

export interface DrizzleClassificationLensReaderDependencies {
  readonly database: unknown;
  readonly deriveCandidates: DeriveHardRuleCandidates;
}

export class DrizzleClassificationLensReader implements IClassificationLensReader {
  private readonly db: RedlineDb;
  private readonly deriveCandidates: DeriveHardRuleCandidates;

  constructor(dependencies: DrizzleClassificationLensReaderDependencies) {
    this.db = dependencies.database as RedlineDb;
    this.deriveCandidates = dependencies.deriveCandidates;
  }

  async readLens(request: ClassificationLensRequest): Promise<Result<ClassificationLens>> {
    const lensId = await this.boundLensId(request.evaluationId);
    if (isErr(lensId)) return err(lensId.error);

    const topics = await this.readTopics(lensId.data);
    if (isErr(topics)) return err(topics.error);

    const ruleSet = await this.readRuleSet(lensId.data);
    if (isErr(ruleSet)) return err(ruleSet.error);

    const candidates = await this.deriveCandidates(request.evaluationId, request.documentIds);
    if (isErr(candidates)) return err(candidates.error);

    return ok({ topics: topics.data, ruleSet: ruleSet.data, candidates: candidates.data });
  }

  private async boundLensId(evaluationId: string): Promise<Result<string>> {
    try {
      const rows = (await this.db
        .select(BINDING_COLUMNS)
        .from(redlineLensBindings)
        .where(eq(redlineLensBindings.evaluationId, evaluationId))
        .limit(1)) as { lensId: string }[];

      const binding = rows[0];
      if (binding === undefined) {
        return err(
          domainError("NOT_FOUND", `no lens is bound to evaluation ${evaluationId}`),
        );
      }
      return ok(binding.lensId);
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "failed to read the lens binding", cause));
    }
  }

  private async readTopics(lensId: string): Promise<Result<readonly Topic[]>> {
    try {
      const rows = (await this.db
        .select(TOPIC_COLUMNS)
        .from(redlineTopics)
        .where(eq(redlineTopics.lensId, lensId))
        .orderBy(asc(redlineTopics.position))) as Topic[];

      // A lens with no topics gives the adjudicator nothing to choose among, so
      // it is a broken lens rather than an empty result.
      if (rows.length === 0) {
        return err(domainError("NOT_FOUND", `lens ${lensId} has no topics`));
      }
      return ok(rows);
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "failed to read the lens topics", cause));
    }
  }

  private async readRuleSet(lensId: string): Promise<Result<HardRuleSet>> {
    try {
      const rows = (await this.db
        .select(HARD_RULE_COLUMNS)
        .from(redlineHardRules)
        .where(eq(redlineHardRules.lensId, lensId))
        .orderBy(asc(redlineHardRules.declarationOrder))) as HardRule[];

      // An empty rule set is legitimate — every document then falls through to
      // adjudication (ADR-0008) — but a stored set that breaks the domain's
      // uniqueness invariants is not, so the factory validates rather than the
      // rows being trusted.
      return makeHardRuleSet({ rules: rows });
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "failed to read the lens hard rules", cause));
    }
  }
}
