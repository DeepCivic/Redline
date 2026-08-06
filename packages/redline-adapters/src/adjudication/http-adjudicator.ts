// HttpAdjudicator — implements the domain's IAdjudicator over an OpenAI-style
// chat/completions LLM seam. Given a document's passages and the lens's candidate
// topics it returns **every topic the document addresses**, each naming the
// chunks that placed it (ADR-0008's cold-start adjudication leg).
//
// One call per document, never one per topic: the whole document goes up once
// and the set comes back, which keeps the spend at M calls rather than N×M. The
// consequence is that evidence has to be asked for explicitly in the response
// shape — a per-topic call would have carried the topic implicitly, and this
// does not — so the prompt requires each returned topic to name its chunk ids.
//
// Designed "as if C" (ADR-0001): the only coupling to the model runtime is
// HTTP + JSON, injected as an AdjudicatorHttpClient so the use-case stays
// unit-testable with a fake and no AI SDK leaks past the boundary. The wire shape
// is the widely-implemented chat/completions JSON-mode contract (a `messages`
// array in, a single `choices[0].message.content` JSON string out, an optional
// `usage` block beside it), so any OpenAI-compatible endpoint satisfies it
// without an adapter change.
//
// Two things the model is never trusted on: a topic that was not offered, and a
// citation to a chunk that was not read. Both are rejected outright, so neither
// a hallucinated topic (ADR-0010) nor a hallucinated deep link can reach a row.

import {
  domainError,
  err,
  isErr,
  ok,
  type Adjudication,
  type AdjudicatedTopic,
  type AdjudicationCost,
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
  "passages, each labelled with its chunk id, and a list of candidate topics. " +
  "Return EVERY candidate topic the document addresses, and no others. Choose " +
  "from the candidates only; never invent a topic, and never return the same " +
  "topic twice. For each topic you return, name the chunk ids of the passages " +
  "that placed it — at least one, and only ids that appear in the passage list. " +
  "A document that addresses none of the candidates is a legitimate answer: " +
  "return an empty topics array rather than forcing a match. Reply with a JSON " +
  'object of exactly two fields: "topics", an array of objects ' +
  '{ "topicId": string, "evidenceChunkIds": array of string, "rationale": one ' +
  'sentence }, and "noTopicReason", one sentence explaining why when "topics" ' +
  'is empty and null otherwise.';

// Stands in when the model returns an empty set without saying why. The
// exception still travels — losing it would make the document invisible, which
// is the one outcome the empty verdict exists to prevent.
const UNEXPLAINED_EMPTY_VERDICT =
  "the adjudicator returned no topics for this document and gave no reason";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The token cost of the one call, or null when the endpoint reported none.
// Zeroes are never substituted: a fabricated figure is worse than an absent one
// when the point of reporting cost is to know the spend rather than assume it.
const readCost = (payload: unknown): AdjudicationCost | null => {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const promptTokens = payload.usage.prompt_tokens;
  const completionTokens = payload.usage.completion_tokens;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
  const totalTokens = payload.usage.total_tokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: typeof totalTokens === "number" ? totalTokens : promptTokens + completionTokens,
  };
};

const readTopic = (entry: unknown): Result<AdjudicatedTopic> => {
  if (
    !isRecord(entry) ||
    typeof entry.topicId !== "string" ||
    typeof entry.rationale !== "string" ||
    !Array.isArray(entry.evidenceChunkIds) ||
    !entry.evidenceChunkIds.every((chunkId): chunkId is string => typeof chunkId === "string")
  ) {
    return err(
      domainError(
        "CLASSIFICATION_FAILED",
        "an adjudicated topic is missing a topicId, a rationale or an evidenceChunkIds array of strings",
      ),
    );
  }
  return ok({
    topicId: entry.topicId,
    evidenceChunkIds: entry.evidenceChunkIds,
    rationale: entry.rationale,
  });
};

interface TopicGuards {
  readonly offeredTopicIds: ReadonlySet<string>;
  readonly offeredChunkIds: ReadonlySet<string>;
  readonly alreadyReturned: ReadonlySet<string>;
}

const checkTopic = (topic: AdjudicatedTopic, guards: TopicGuards): Result<null> => {
  if (!guards.offeredTopicIds.has(topic.topicId)) {
    return err(
      domainError(
        "CLASSIFICATION_FAILED",
        `adjudicator returned "${topic.topicId}", which was not a candidate topic`,
      ),
    );
  }
  if (guards.alreadyReturned.has(topic.topicId)) {
    return err(
      domainError(
        "CLASSIFICATION_FAILED",
        `adjudicator returned "${topic.topicId}" more than once; a verdict is a set of topics`,
      ),
    );
  }
  if (topic.evidenceChunkIds.length === 0) {
    return err(
      domainError(
        "CLASSIFICATION_FAILED",
        `adjudicator returned "${topic.topicId}" with no evidence; every topic must name the chunks that placed it`,
      ),
    );
  }
  const unread = topic.evidenceChunkIds.find((chunkId) => !guards.offeredChunkIds.has(chunkId));
  if (unread !== undefined) {
    return err(
      domainError(
        "CLASSIFICATION_FAILED",
        `adjudicator cited chunk "${unread}" for "${topic.topicId}", which was not among the passages it was given`,
      ),
    );
  }
  return ok(null);
};

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
    if (isErr(body)) return err(body.error);

    const content = this.extractContent(body.data);
    if (isErr(content)) return err(content.error);

    const parsed = parseJsonObject(content.data);
    if (isErr(parsed)) return err(parsed.error);

    const topics = validateTopics(parsed.data, request);
    if (isErr(topics)) return err(topics.error);

    return ok({
      documentId: request.documentId,
      topics: topics.data,
      exception:
        topics.data.length > 0
          ? null
          : {
              documentId: request.documentId,
              detail: readNoTopicReason(parsed.data),
            },
      cost: readCost(body.data),
    });
  }

  private buildUserPrompt(request: AdjudicationRequest): string {
    const passages = request.passages
      .map((passage) => `[${passage.chunkId}] ${passage.text}`)
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

  private extractContent(payload: unknown): Result<string> {
    if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      return err(domainError("CLASSIFICATION_FAILED", "adjudication response has no choices"));
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

// The model's own content is a JSON string it produced, not the transport's, so
// its failures map to CLASSIFICATION_FAILED — an unusable verdict, not an infra
// fault.
const parseJsonObject = (content: string): Result<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    return err(
      domainError("CLASSIFICATION_FAILED", "adjudicator content was not valid JSON", cause),
    );
  }
  if (!isRecord(parsed)) {
    return err(domainError("CLASSIFICATION_FAILED", "adjudicator content was not a JSON object"));
  }
  return ok(parsed);
};

const validateTopics = (
  verdict: Record<string, unknown>,
  request: AdjudicationRequest,
): Result<readonly AdjudicatedTopic[]> => {
  if (!Array.isArray(verdict.topics)) {
    return err(
      domainError("CLASSIFICATION_FAILED", "adjudicator verdict is missing a topics array"),
    );
  }

  const offeredTopicIds = new Set(request.candidates.map((candidate) => candidate.topicId));
  const offeredChunkIds = new Set(request.passages.map((passage) => passage.chunkId));
  const alreadyReturned = new Set<string>();
  const topics: AdjudicatedTopic[] = [];

  for (const entry of verdict.topics) {
    const topic = readTopic(entry);
    if (isErr(topic)) return err(topic.error);

    const checked = checkTopic(topic.data, { offeredTopicIds, offeredChunkIds, alreadyReturned });
    if (isErr(checked)) return err(checked.error);

    alreadyReturned.add(topic.data.topicId);
    topics.push(topic.data);
  }

  return ok(topics);
};

const readNoTopicReason = (verdict: Record<string, unknown>): string => {
  const reason = verdict.noTopicReason;
  if (typeof reason !== "string" || reason.trim() === "") return UNEXPLAINED_EMPTY_VERDICT;
  return reason;
};
