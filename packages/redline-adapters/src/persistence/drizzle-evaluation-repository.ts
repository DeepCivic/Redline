// DrizzleEvaluationRepository — persists the evaluation aggregate into the
// redline_ schema (ADR-0002). Implements IEvaluationRepository, so every method
// returns a Result and no driver exception crosses the port. Saves are upserts
// (onConflictDoUpdate) so a use-case can re-run a stage without a pre-check.
//
// The db handle is injected as a drizzle instance bound to the redline_ schema;
// the concrete driver (postgres-js in production, PGlite in tests) is the
// caller's choice — this class depends only on the query builder.

import {
  domainError,
  err,
  ok,
  type Evaluation,
  type IEvaluationRepository,
  type ProcurementResponse,
  type ResponseGroup,
  type Result,
  type Vendor,
} from "@redline/redline-domain";
import { eq } from "drizzle-orm";
import {
  redlineEvaluations,
  redlineResponseGroups,
  redlineResponses,
  redlineVendors,
} from "./schema";
import {
  evaluationToRow,
  responseGroupToRow,
  responseToRow,
  rowToEvaluation,
  rowToResponse,
  rowToResponseGroup,
  rowToVendor,
  vendorToRow,
} from "./row-mapping";

// The minimal drizzle surface the repository uses. Kept structural so both the
// postgres-js and PGlite drizzle instances satisfy it without a driver import.
interface RedlineDb {
  insert: (table: unknown) => {
    values: (row: unknown) => {
      onConflictDoUpdate: (config: unknown) => Promise<unknown>;
      onConflictDoNothing: () => Promise<unknown>;
    };
  };
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<unknown[]>;
    };
  };
}

// A response has no domain id; mint a stable one per (group, requirement, doc).
const responseId = (response: ProcurementResponse): string =>
  `${response.responseGroupId}:${response.requirementId}:${response.source.documentId}`;

const failed = (message: string, cause: unknown) =>
  err(domainError("INFRA_FAILURE", message, cause));

export class DrizzleEvaluationRepository implements IEvaluationRepository {
  private readonly db: RedlineDb;

  constructor(database: unknown) {
    this.db = database as RedlineDb;
  }

  async saveEvaluation(evaluation: Evaluation): Promise<Result<Evaluation>> {
    try {
      await this.db
        .insert(redlineEvaluations)
        .values(evaluationToRow(evaluation))
        .onConflictDoUpdate({
          target: redlineEvaluations.id,
          set: { name: evaluation.name, stage: evaluation.stage, updatedAt: new Date() },
        });
      return ok(evaluation);
    } catch (cause) {
      return failed("failed to save evaluation", cause);
    }
  }

  async findEvaluation(evaluationId: string): Promise<Result<Evaluation>> {
    try {
      const rows = (await this.db
        .select()
        .from(redlineEvaluations)
        .where(eq(redlineEvaluations.id, evaluationId))) as (typeof redlineEvaluations.$inferSelect)[];
      const row = rows[0];
      if (!row) {
        return err(domainError("NOT_FOUND", `no evaluation ${evaluationId}`));
      }
      return ok(rowToEvaluation(row));
    } catch (cause) {
      return failed("failed to read evaluation", cause);
    }
  }

  async saveVendor(evaluationId: string, vendor: Vendor): Promise<Result<Vendor>> {
    try {
      await this.db
        .insert(redlineVendors)
        .values(vendorToRow(evaluationId, vendor))
        .onConflictDoUpdate({
          target: redlineVendors.id,
          set: {
            displayName: vendor.displayName,
            isConsortium: vendor.isConsortium,
            memberVendorIds: [...vendor.memberVendorIds],
            updatedAt: new Date(),
          },
        });
      return ok(vendor);
    } catch (cause) {
      return failed("failed to save vendor", cause);
    }
  }

  async listVendors(evaluationId: string): Promise<Result<readonly Vendor[]>> {
    try {
      const rows = (await this.db
        .select()
        .from(redlineVendors)
        .where(eq(redlineVendors.evaluationId, evaluationId))) as (typeof redlineVendors.$inferSelect)[];
      return ok(rows.map(rowToVendor));
    } catch (cause) {
      return failed("failed to list vendors", cause);
    }
  }

  async saveResponseGroup(group: ResponseGroup): Promise<Result<ResponseGroup>> {
    try {
      await this.db
        .insert(redlineResponseGroups)
        .values(responseGroupToRow(group))
        .onConflictDoUpdate({
          target: redlineResponseGroups.id,
          set: {
            label: group.label,
            vendorIds: [...group.vendorIds],
            documentIds: [...group.documentIds],
            isConsortiumResponse: group.isConsortiumResponse,
            updatedAt: new Date(),
          },
        });
      return ok(group);
    } catch (cause) {
      return failed("failed to save response group", cause);
    }
  }

  async listResponseGroups(
    evaluationId: string,
  ): Promise<Result<readonly ResponseGroup[]>> {
    try {
      const rows = (await this.db
        .select()
        .from(redlineResponseGroups)
        .where(
          eq(redlineResponseGroups.evaluationId, evaluationId),
        )) as (typeof redlineResponseGroups.$inferSelect)[];
      return ok(rows.map(rowToResponseGroup));
    } catch (cause) {
      return failed("failed to list response groups", cause);
    }
  }

  async saveResponses(
    responses: readonly ProcurementResponse[],
  ): Promise<Result<readonly ProcurementResponse[]>> {
    try {
      for (const response of responses) {
        const id = responseId(response);
        await this.db
          .insert(redlineResponses)
          .values(responseToRow(id, response))
          .onConflictDoUpdate({
            target: redlineResponses.id,
            set: { ...responseToRow(id, response), updatedAt: new Date() },
          });
      }
      return ok(responses);
    } catch (cause) {
      return failed("failed to save responses", cause);
    }
  }

  async listResponses(
    evaluationId: string,
  ): Promise<Result<readonly ProcurementResponse[]>> {
    try {
      const rows = (await this.db
        .select()
        .from(redlineResponses)
        .where(
          eq(redlineResponses.evaluationId, evaluationId),
        )) as (typeof redlineResponses.$inferSelect)[];
      return ok(rows.map(rowToResponse));
    } catch (cause) {
      return failed("failed to list responses", cause);
    }
  }
}
