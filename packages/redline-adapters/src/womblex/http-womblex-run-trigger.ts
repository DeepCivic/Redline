// HttpWomblexRunTrigger — implements the domain's IWomblexRunTrigger over the
// womblex-ingest sidecar's run endpoints (`POST /runs`, `GET /runs/{runId}`,
// `POST /runs/{runId}/resume`).
//
// This is redline's second seam to the womblex engine (architecture §3/§5): the
// first was object storage (the engine writes shards, the sidecar reads them);
// this one triggers a run into the engine's job queue and reads its state. The
// sidecar owns the queue-schema knowledge and the CLI sequencing — redline calls
// two JSON endpoints and does not reimplement the engine's batching, retry or
// scale-out.
//
// Designed "as if C": the only coupling to the sidecar is HTTP + JSON, and every
// network/parse failure is caught here and returned as a DomainError — nothing
// throws across the port edge.

import {
  domainError,
  type DomainError,
  type IWomblexRunTrigger,
  type Result,
  type RunStatusView,
  type TriggerRunRequest,
  err,
  ok,
} from "@redline/redline-domain";

// A `fetch`-shaped seam that carries method + body, so the adapter POSTs a
// trigger and GETs a status without assuming a global fetch. Injected in tests.
export interface RunTriggerHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface RunTriggerHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
}

export type RunTriggerHttpClient = (
  request: RunTriggerHttpRequest,
) => Promise<RunTriggerHttpResponse>;

export interface HttpWomblexRunTriggerOptions {
  // Base URL of the womblex-ingest sidecar, e.g. "http://womblex-ingest:8000".
  readonly baseUrl: string;
  readonly httpClient: RunTriggerHttpClient;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isPhase = (value: unknown): value is RunStatusView["phase"] =>
  value === "extracting" || value === "staging" || value === "done" || value === "errored";

// Narrow the sidecar's status body into a RunStatusView, or an EXTRACTION_FAILED
// error naming the first structural violation. The status seam is the one the UI
// binds to, so a malformed body is a seam fault, not a silently-thin view.
const parseStatus = (body: unknown): Result<RunStatusView> => {
  if (!isRecord(body)) {
    return err(domainError("EXTRACTION_FAILED", "run status payload is not an object"));
  }
  if (typeof body.runId !== "string" || typeof body.evaluationId !== "string") {
    return err(domainError("EXTRACTION_FAILED", "run status payload missing runId/evaluationId"));
  }
  if (!isPhase(body.phase)) {
    return err(domainError("EXTRACTION_FAILED", "run status payload has an unknown phase"));
  }
  if (!isStringArray(body.completedStages)) {
    return err(domainError("EXTRACTION_FAILED", "run status payload has malformed completedStages"));
  }
  const failedStage = body.failedStage;
  if (failedStage !== null && typeof failedStage !== "string") {
    return err(domainError("EXTRACTION_FAILED", "run status payload has a malformed failedStage"));
  }
  const error = body.error;
  if (error !== null && typeof error !== "string") {
    return err(domainError("EXTRACTION_FAILED", "run status payload has a malformed error"));
  }
  return ok({
    runId: body.runId,
    evaluationId: body.evaluationId,
    phase: body.phase,
    completedStages: body.completedStages,
    failedStage,
    resumable: body.resumable === true,
    error,
  });
};

const parseRunId = (body: unknown): Result<{ readonly runId: string }> => {
  if (!isRecord(body) || typeof body.runId !== "string") {
    return err(domainError("EXTRACTION_FAILED", "run trigger payload missing runId"));
  }
  return ok({ runId: body.runId });
};

// Map a non-2xx response's Result-shaped body into a DomainError. The sidecar's
// RUN_NOT_FOUND becomes NOT_FOUND and its INVALID_REQUEST becomes
// VALIDATION_FAILED; anything else at this seam is an infrastructure failure.
const parseErrorBody = (status: number, body: unknown): DomainError => {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    const code = typeof body.error.code === "string" ? body.error.code : "INFRA_FAILURE";
    if (code === "RUN_NOT_FOUND") return domainError("NOT_FOUND", body.error.message);
    if (code === "INVALID_REQUEST") return domainError("VALIDATION_FAILED", body.error.message);
    return domainError("INFRA_FAILURE", body.error.message);
  }
  return domainError("INFRA_FAILURE", `womblex-ingest returned HTTP ${status}`);
};

export class HttpWomblexRunTrigger implements IWomblexRunTrigger {
  private readonly baseUrl: string;
  private readonly httpClient: RunTriggerHttpClient;

  constructor(options: HttpWomblexRunTriggerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
  }

  async start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>> {
    return this.send(
      { url: `${this.baseUrl}/runs`, method: "POST", body: {
        evaluationId: request.evaluationId,
        stageSequence: [...request.stageSequence],
      } },
      parseRunId,
    );
  }

  async status(runId: string): Promise<Result<RunStatusView>> {
    return this.send(
      { url: `${this.baseUrl}/runs/${encodeURIComponent(runId)}`, method: "GET" },
      parseStatus,
    );
  }

  async resume(runId: string): Promise<Result<{ readonly runId: string }>> {
    return this.send(
      { url: `${this.baseUrl}/runs/${encodeURIComponent(runId)}/resume`, method: "POST" },
      parseRunId,
    );
  }

  // One request/parse path so every call catches its own transport and parse
  // failures — no driver exception crosses the port edge.
  private async send<T>(
    request: RunTriggerHttpRequest,
    parse: (body: unknown) => Result<T>,
  ): Promise<Result<T>> {
    let response: RunTriggerHttpResponse;
    try {
      response = await this.httpClient(request);
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "womblex-ingest is unreachable", cause));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      return err(domainError("EXTRACTION_FAILED", "womblex-ingest returned a non-JSON body", cause));
    }

    if (!response.ok) {
      return err(parseErrorBody(response.status, body));
    }
    return parse(body);
  }
}
