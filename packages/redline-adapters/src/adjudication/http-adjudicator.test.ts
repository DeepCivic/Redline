import { describe, it, expect } from "vitest";
import { isErr, isOk, type AdjudicationRequest } from "@redline/redline-domain";
import {
  HttpAdjudicator,
  type AdjudicatorHttpClient,
  type AdjudicatorHttpRequest,
  type AdjudicatorHttpResponse,
} from "./http-adjudicator";

// The adjudicator's LLM seam is HTTP + JSON, "as if C" (ADR-0001): the only
// coupling is a POST of the document's passages + candidate topics and a JSON
// verdict back. Tests inject a fake client, so the adapter is provable without a
// live model. The wire contract this fake honours mirrors an OpenAI-style
// chat/completions JSON-mode response: a single message whose content is a JSON
// object `{ "topics": [...], "noTopicReason": ... }`, alongside the envelope's
// own `usage` block.

const jsonResponse = (body: unknown): AdjudicatorHttpResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const completion = (content: unknown, usage?: unknown): unknown => ({
  choices: [{ message: { content: JSON.stringify(content) } }],
  ...(usage === undefined ? {} : { usage }),
});

// Five topics and three passages — the exit test's shape: a document whose
// passages address three of the five.
const request = (over: Partial<AdjudicationRequest> = {}): AdjudicationRequest => ({
  documentId: "hashA",
  passages: [
    { chunkId: "hashA:0", text: "The switch supports 48 PoE ports at 802.3bt." },
    { chunkId: "hashA:1", text: "Annual support is 24/7 with a four-hour response." },
    { chunkId: "hashA:2", text: "The licence is $40,000 per annum excluding GST." },
  ],
  candidates: [
    { topicId: "req-network", name: "Networking", definition: "Switches, routers, PoE." },
    { topicId: "req-power", name: "Power", definition: "UPS and power distribution." },
    { topicId: "req-support", name: "Support", definition: "Helpdesk and response times." },
    { topicId: "req-commercial", name: "Commercial", definition: "Prices and licence fees." },
    { topicId: "req-security", name: "Security", definition: "Access control and hardening." },
  ],
  ...over,
});

const threeOfFive = {
  topics: [
    { topicId: "req-network", evidenceChunkIds: ["hashA:0"], rationale: "It is a PoE switch." },
    { topicId: "req-support", evidenceChunkIds: ["hashA:1"], rationale: "It states response times." },
    {
      topicId: "req-commercial",
      evidenceChunkIds: ["hashA:2"],
      rationale: "It states an annual licence fee.",
    },
  ],
  noTopicReason: null,
};

const capturingClient = (
  body: unknown,
): { client: AdjudicatorHttpClient; sent: AdjudicatorHttpRequest[] } => {
  const sent: AdjudicatorHttpRequest[] = [];
  const client: AdjudicatorHttpClient = async (req) => {
    sent.push(req);
    return jsonResponse(body);
  };
  return { client, sent };
};

const buildAdjudicator = (client: AdjudicatorHttpClient): HttpAdjudicator =>
  new HttpAdjudicator({
    baseUrl: "https://llm.example/v1",
    apiKey: "test-key",
    model: "gpt-4o-mini",
    httpClient: client,
  });

describe("HttpAdjudicator — the LLM adjudication seam", () => {
  it("returns every topic the document addresses and no others, from one call", async () => {
    const { client, sent } = capturingClient(completion(threeOfFive));
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // Three of the five offered topics came back, each naming the chunk that
    // placed it — and the model was asked exactly once.
    expect(result.data.documentId).toBe("hashA");
    expect(result.data.topics.map((topic) => topic.topicId)).toEqual([
      "req-network",
      "req-support",
      "req-commercial",
    ]);
    expect(result.data.topics.map((topic) => topic.evidenceChunkIds)).toEqual([
      ["hashA:0"],
      ["hashA:1"],
      ["hashA:2"],
    ]);
    expect(result.data.exception).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("reports the call's token cost from the response envelope", async () => {
    const { client } = capturingClient(
      completion(threeOfFive, {
        prompt_tokens: 1450,
        completion_tokens: 210,
        total_tokens: 1660,
      }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.cost).toEqual({
      promptTokens: 1450,
      completionTokens: 210,
      totalTokens: 1660,
    });
  });

  it("reports a null cost when the endpoint sends no usage — never a fabricated zero", async () => {
    const { client } = capturingClient(completion(threeOfFive));
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.cost).toBeNull();
  });

  it("returns an empty set with an exception for a document that addresses nothing", async () => {
    const { client } = capturingClient(
      completion({
        topics: [],
        noTopicReason: "The passages are a covering letter and address none of the topics.",
      }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    // A legitimate verdict, not a failed call — but it must arrive as an
    // exception, because it produces no rows and would otherwise be silence.
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics).toEqual([]);
    expect(result.data.exception).toEqual({
      documentId: "hashA",
      detail: "The passages are a covering letter and address none of the topics.",
    });
  });

  it("still reports an exception when the model gives no reason for the empty set", async () => {
    const { client } = capturingClient(completion({ topics: [] }));
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics).toEqual([]);
    expect(result.data.exception?.documentId).toBe("hashA");
    expect(result.data.exception?.detail).not.toBe("");
  });

  it("sends the chunk-addressed passages, the candidates and the model in the request body", async () => {
    const { client, sent } = capturingClient(completion(threeOfFive));
    const adjudicator = buildAdjudicator(client);

    await adjudicator.adjudicate(request());

    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only!.method).toBe("POST");
    expect(only!.url).toBe("https://llm.example/v1/chat/completions");
    expect(only!.headers.Authorization).toBe("Bearer test-key");
    const body = only!.body as { model: string; messages: { content: string }[] };
    expect(body.model).toBe("gpt-4o-mini");
    // The prompt carries the passage text labelled by chunk id — the model can
    // only cite evidence it can name — and every candidate id.
    const prompt = body.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("The switch supports 48 PoE ports");
    expect(prompt).toContain("hashA:0");
    expect(prompt).toContain("req-network");
    expect(prompt).toContain("req-security");
  });

  it("rejects a topic that was not a candidate — the model may not invent one", async () => {
    const { client } = capturingClient(
      completion({
        topics: [
          { topicId: "req-network", evidenceChunkIds: ["hashA:0"], rationale: "ok" },
          { topicId: "req-catering", evidenceChunkIds: ["hashA:1"], rationale: "off-list" },
        ],
        noTopicReason: null,
      }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
    expect(result.error.message).toContain("req-catering");
  });

  it("rejects evidence naming a chunk the request never offered", async () => {
    const { client } = capturingClient(
      completion({
        topics: [{ topicId: "req-network", evidenceChunkIds: ["hashB:9"], rationale: "cited" }],
        noTopicReason: null,
      }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    // A citation to a chunk that was never read is a hallucination, and the row
    // it would produce would deep-link to a passage that did not place it.
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
    expect(result.error.message).toContain("hashB:9");
  });

  it("rejects a topic that names no evidence at all", async () => {
    const { client } = capturingClient(
      completion({
        topics: [{ topicId: "req-network", evidenceChunkIds: [], rationale: "trust me" }],
        noTopicReason: null,
      }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("rejects the same topic returned twice — a set, not a list", async () => {
    const { client } = capturingClient(
      completion({
        topics: [
          { topicId: "req-network", evidenceChunkIds: ["hashA:0"], rationale: "once" },
          { topicId: "req-network", evidenceChunkIds: ["hashA:1"], rationale: "twice" },
        ],
        noTopicReason: null,
      }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
    expect(result.error.message).toContain("req-network");
  });

  it("fails when the model omits the topics array", async () => {
    const { client } = capturingClient(completion({ noTopicReason: "no idea" }));
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("fails when the model's content is not JSON", async () => {
    const { client } = capturingClient({
      choices: [{ message: { content: "I think it is networking." } }],
    });
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("maps a transport failure to INFRA_FAILURE (nothing throws across the port)", async () => {
    const client: AdjudicatorHttpClient = async () => {
      throw new Error("connection refused");
    };
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });

  it("maps a non-2xx response to a DomainError", async () => {
    const client: AdjudicatorHttpClient = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "rate limited" } }),
    });
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("rejects a request with fewer than two candidates (nothing to adjudicate)", async () => {
    const { client } = capturingClient(completion(threeOfFive));
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(
      request({ candidates: [{ topicId: "req-network", name: "Networking", definition: "x" }] }),
    );

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
