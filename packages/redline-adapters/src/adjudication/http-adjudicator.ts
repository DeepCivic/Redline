// HttpAdjudicator — implements the domain's IAdjudicator over an OpenAI-style
// chat/completions LLM seam. It settles what hard rules and structural fetch left
// genuinely unclear (design doc §3): given a document's passages and the
// candidate topics it could belong to, the model picks ONE candidate and states,
// in one sentence, why (ADR-0008's cold-start adjudication leg).
//
// Designed "as if C" (ADR-0001): the only coupling to the model runtime is
// HTTP + JSON, injected as an AdjudicatorHttpClient so the use-case stays
// unit-testable with a fake and no AI SDK leaks past the boundary. The wire shape
// is the widely-implemented chat/completions JSON-mode contract (a `messages`
// array in, a single `choices[0].message.content` JSON string out), so any
// OpenAI-compatible endpoint satisfies it without an adapter change.
//
// The model may only choose among the request's candidates — a verdict for an
// off-list topic is rejected, never trusted, so a hallucinated topic can never
// become a RequirementClassification (ADR-0010).

import {
  domainError,
  err,
  ok,
  type Adjudication,
  type AdjudicationRequest,
  type IAdjudicator,
  type Result,
} from "@redline/redline-domain";

export interface AdjudicatorHttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface AdjudicatorHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type AdjudicatorHttpClient = (
  request: AdjudicatorHttpRequest,
) => Promise<AdjudicatorHttpResponse>;

export interface HttpAdjudicatorOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly httpClient: AdjudicatorHttpClient;
  // Optional determinism knob; defaults to 0 so the same passages adjudicate the
  // same way run to run (the lens is a reproducible artefact, design §3).
  readonly temperature?: number;
}

const SYSTEM_PROMPT =
  "You are a procurement-evaluation adjudicator. You are given a document's " +
  "passages and a numbered list of candidate topics. Choose the ONE candidate " +
  "the document best matches. You must choose from the candidates only; never " +
  "invent a topic. Reply with a JSON object of exactly two string fields: " +
  '"chosenTopicId" (one of the candidate ids) and "rationale" (one sentence).';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export class HttpAdjudicator implements IAdjudicator {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly httpClient: AdjudicatorHttpClient;
  private readonly temperature: number;

  constructor(options: HttpAdjudicatorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.httpClient = options.httpClient;
    this.temperature = options.temperature ?? 0;
  }

  async adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>> {
    if (request.candidates.length < 2) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          "adjudication needs at least two candidate topics; there is nothing to adjudicate otherwise",
        ),
      );
    }

    const body = await this.send(request);
    if (body.error) return err(body.error);

    const verdict = this.parseVerdict(body.data);
    if (verdict.error) return err(verdict.error);

    const candidateIds = new Set(request.candidates.map((candidate) => candidate.topicId));
    if (!candidateIds.has(verdict.data.chosenTopicId)) {
      return err(
        domainError(
          "CLASSIFICATION_FAILED",
          `adjudicator chose "${verdict.data.chosenTopicId}", which was not a candidate topic`,
        ),
      );
    }

    return ok({
      documentId: request.documentId,
      chosenTopicId: verdict.data.chosenTopicId,
      rationale: verdict.data.rationale,
    });
  }

  private buildUserPrompt(request: AdjudicationRequest): string {
    const passages = request.passages
      .map((passage, index) => `[${index + 1}] ${passage}`)
      .join("\n");
    const candidates = request.candidates
      .map((candidate) => `- ${candidate.topicId}: ${candidate.name} — ${candidate.definition}`)
      .join("\n");
    return `Passages:\n${passages}\n\nCandidate topics:\n${candidates}`;
  }

  private async send(request: AdjudicationRequest): Promise<Result<unknown>> {
    let response: AdjudicatorHttpResponse;
    try {
      response = await this.httpClient({
        method: "POST",
        url: `${this.baseUrl}/chat/completions`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: {
          model: this.model,
          temperature: this.temperature,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: this.buildUserPrompt(request) },
          ],
        },
      });
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "adjudication model is unreachable", cause));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      return err(
        domainError("CLASSIFICATION_FAILED", "adjudication model returned a non-JSON body", cause),
      );
    }

    if (!response.ok) {
      return err(
        domainError("CLASSIFICATION_FAILED", `adjudication model returned HTTP ${response.status}`),
      );
    }
    return ok(payload);
  }

  // Pull the JSON verdict out of the chat/completions envelope. Two layers can
  // fail: the envelope shape, and the model's own content (which is a JSON string
  // the model produced, not the transport's). Both map to CLASSIFICATION_FAILED —
  // an unusable verdict, not an infra fault.
  private parseVerdict(
    payload: unknown,
  ): Result<{ chosenTopicId: string; rationale: string }> {
    const content = this.extractContent(payload);
    if (content.error) return err(content.error);

    let parsed: unknown;
    try {
      parsed = JSON.parse(content.data);
    } catch (cause) {
      return err(
        domainError("CLASSIFICATION_FAILED", "adjudicator content was not valid JSON", cause),
      );
    }

    if (
      !isRecord(parsed) ||
      typeof parsed.chosenTopicId !== "string" ||
      typeof parsed.rationale !== "string"
    ) {
      return err(
        domainError(
          "CLASSIFICATION_FAILED",
          "adjudicator verdict is missing a chosenTopicId or rationale string",
        ),
      );
    }

    return ok({ chosenTopicId: parsed.chosenTopicId, rationale: parsed.rationale });
  }

  private extractContent(payload: unknown): Result<string> {
    if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      return err(
        domainError("CLASSIFICATION_FAILED", "adjudication response has no choices"),
      );
    }
    const [firstChoice] = payload.choices;
    if (
      !isRecord(firstChoice) ||
      !isRecord(firstChoice.message) ||
      typeof firstChoice.message.content !== "string"
    ) {
      return err(
        domainError("CLASSIFICATION_FAILED", "adjudication response has no message content"),
      );
    }
    return ok(firstChoice.message.content);
  }
}
