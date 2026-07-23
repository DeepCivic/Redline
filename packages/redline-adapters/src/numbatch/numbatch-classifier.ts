// NumbatchClassifier — implements the domain's IProcurementClassifier over the
// Numbatch backend's batch-inference API (DeepCivic/Numbatch). One
// classifyResponseGroup call:
//
//   1. POST /batch-inference/trigger { profile_id, strategy, source_doc_ids }
//   2. poll GET /batch-inference/jobs/{id} until succeeded | failed
//   3. GET  /batch-inference/jobs/{id}/documents  (the per-document roll-up)
//   4. map each roll-up topic_id → the evaluation's requirementId (ADR-0004)
//
// The topic_id ↔ requirementId translation is the whole reason this adapter
// exists: redline speaks "requirement", Numbatch speaks "topic". The mapping is
// injected as a NumbatchProfileBinding, built when the profile was bootstrapped.
//
// Designed "as if C" (ADR-0001): the only coupling to Numbatch is HTTP + JSON.

import {
  domainError,
  type IProcurementClassifier,
  type ClassificationRequest,
  type RequirementClassification,
  type Result,
  err,
  ok,
} from "@redline/redline-domain";
import {
  parseBatchJob,
  parseDocumentRollup,
  parseErrorBody,
  type WireBatchJob,
  type WireDocumentClassification,
} from "./wire";

// A minimal, method-aware HTTP seam so the classifier can POST a JSON body and
// tests inject a fake without a live server. Only what the classifier needs.
export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

// Binds one evaluation to the Numbatch profile that classifies it. `strategy`
// is Numbatch's roll-up strategy (e.g. "majority_vote"); `topicToRequirement`
// maps each profile topic_id back to the evaluation's requirementId.
export interface NumbatchProfileBinding {
  readonly profileId: string;
  readonly strategy: string;
  readonly topicToRequirement: Readonly<Record<string, string>>;
}

export interface NumbatchClassifierOptions {
  readonly baseUrl: string;
  readonly httpClient: HttpClient;
  readonly binding: NumbatchProfileBinding;
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_POLL_ATTEMPTS = 120;

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class NumbatchClassifier implements IProcurementClassifier {
  private readonly baseUrl: string;
  private readonly httpClient: HttpClient;
  private readonly binding: NumbatchProfileBinding;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;

  constructor(options: NumbatchClassifierOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.httpClient = options.httpClient;
    this.binding = options.binding;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  }

  async classifyResponseGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>> {
    const triggered = await this.triggerRun(request.documentIds);
    if (triggered.error) return err(triggered.error);

    const finished = await this.awaitCompletion(triggered.data.id);
    if (finished.error) return err(finished.error);

    const documents = await this.readRollup(triggered.data.id);
    if (documents.error) return err(documents.error);

    return ok(this.mapRollup(documents.data));
  }

  private async triggerRun(
    documentIds: readonly string[],
  ): Promise<Result<WireBatchJob>> {
    const body = await this.send({
      method: "POST",
      url: `${this.baseUrl}/batch-inference/trigger`,
      body: {
        profile_id: this.binding.profileId,
        strategy: this.binding.strategy,
        source_doc_ids: [...documentIds],
      },
    });
    if (body.error) return err(body.error);
    return parseBatchJob(body.data);
  }

  private async awaitCompletion(jobId: string): Promise<Result<WireBatchJob>> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const body = await this.send({
        method: "GET",
        url: `${this.baseUrl}/batch-inference/jobs/${encodeURIComponent(jobId)}`,
      });
      if (body.error) return err(body.error);

      const job = parseBatchJob(body.data);
      if (job.error) return err(job.error);

      if (job.data.status === "succeeded") return ok(job.data);
      if (job.data.status === "failed") {
        return err(
          domainError(
            "CLASSIFICATION_FAILED",
            job.data.error ?? "numbatch batch-inference run failed",
          ),
        );
      }

      await sleep(this.pollIntervalMs);
    }

    return err(
      domainError(
        "CLASSIFICATION_FAILED",
        "numbatch batch-inference run did not complete within the poll budget",
      ),
    );
  }

  private async readRollup(
    jobId: string,
  ): Promise<Result<readonly WireDocumentClassification[]>> {
    const body = await this.send({
      method: "GET",
      url: `${this.baseUrl}/batch-inference/jobs/${encodeURIComponent(jobId)}/documents`,
    });
    if (body.error) return err(body.error);
    return parseDocumentRollup(body.data);
  }

  // One RequirementClassification per (document, matched requirement). Topics
  // with no requirement mapping are dropped rather than invented — the binding
  // is the source of truth for which topics belong to this evaluation. The
  // roll-up is per document, so no per-chunk provenance is available here.
  private mapRollup(
    documents: readonly WireDocumentClassification[],
  ): readonly RequirementClassification[] {
    const rows: RequirementClassification[] = [];
    for (const document of documents) {
      for (const topic of document.topics) {
        const requirementId = this.binding.topicToRequirement[topic.topicId];
        if (!requirementId) continue;
        rows.push({
          documentId: document.sourceDocId,
          requirementId,
          confidence: topic.score,
          sourceChunkId: null,
        });
      }
    }
    return rows;
  }

  // Send one request, mapping transport / non-JSON / non-2xx failures to
  // DomainErrors so nothing throws across the port edge.
  private async send(request: HttpRequest): Promise<Result<unknown>> {
    let response: HttpResponse;
    try {
      response = await this.httpClient(request);
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "numbatch backend is unreachable", cause));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      return err(
        domainError("CLASSIFICATION_FAILED", "numbatch returned a non-JSON body", cause),
      );
    }

    if (!response.ok) return err(parseErrorBody(response.status, body));
    return ok(body);
  }
}
