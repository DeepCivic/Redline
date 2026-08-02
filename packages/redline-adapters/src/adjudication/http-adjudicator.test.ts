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
// object `{ "chosenTopicId": ..., "rationale": ... }`.

const jsonResponse = (body: unknown): AdjudicatorHttpResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const completion = (content: unknown): unknown => ({
  choices: [{ message: { content: JSON.stringify(content) } }],
});

const request = (over: Partial<AdjudicationRequest> = {}): AdjudicationRequest => ({
  documentId: "hashA",
  passages: ["The switch supports 48 PoE ports at 802.3bt."],
  candidates: [
    { topicId: "req-network", name: "Networking", definition: "Switches, routers, PoE." },
    { topicId: "req-power", name: "Power", definition: "UPS and power distribution." },
  ],
  ...over,
});

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
  it("returns the chosen topic and its rationale for a clear verdict", async () => {
    const { client } = capturingClient(
      completion({ chosenTopicId: "req-network", rationale: "It is a PoE network switch." }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual({
      documentId: "hashA",
      chosenTopicId: "req-network",
      rationale: "It is a PoE network switch.",
    });
  });

  it("sends the passages, candidates and model in the request body", async () => {
    const { client, sent } = capturingClient(
      completion({ chosenTopicId: "req-network", rationale: "why" }),
    );
    const adjudicator = buildAdjudicator(client);

    await adjudicator.adjudicate(request());

    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only!.method).toBe("POST");
    expect(only!.url).toBe("https://llm.example/v1/chat/completions");
    expect(only!.headers.Authorization).toBe("Bearer test-key");
    const body = only!.body as { model: string; messages: { content: string }[] };
    expect(body.model).toBe("gpt-4o-mini");
    // The prompt must carry both the passage text and every candidate id, so the
    // model reasons over the real material and chooses only among the candidates.
    const prompt = body.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("The switch supports 48 PoE ports");
    expect(prompt).toContain("req-network");
    expect(prompt).toContain("req-power");
  });

  it("rejects a verdict for a topic that was not a candidate — the model may not invent one", async () => {
    const { client } = capturingClient(
      completion({ chosenTopicId: "req-security", rationale: "off-list" }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("fails when the model omits a chosen topic", async () => {
    const { client } = capturingClient(completion({ rationale: "no choice made" }));
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
    const { client } = capturingClient(
      completion({ chosenTopicId: "req-network", rationale: "only one" }),
    );
    const adjudicator = buildAdjudicator(client);

    const result = await adjudicator.adjudicate(
      request({ candidates: [{ topicId: "req-network", name: "Networking", definition: "x" }] }),
    );

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
