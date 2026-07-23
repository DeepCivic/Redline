import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import {
  NumbatchClassifier,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type NumbatchProfileBinding,
} from "./numbatch-classifier";
import rollup from "./__fixtures__/batch-rollup.json";

// A captured Numbatch payload (see __fixtures__/README.md): `.job` is the
// trigger/status body, `.documents` is the per-document roll-up. The contract:
// this adapter turns that JSON into RequirementClassification[], mapping each
// Numbatch topic_id to the evaluation's requirementId.

const jsonResponse = (status: number, body: unknown): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// The bootstrap binding: which Numbatch profile classifies this evaluation and
// how its topic_ids map back to redline requirementIds.
const binding: NumbatchProfileBinding = {
  profileId: "9a8b7c6d-0000-4000-8000-000000000042",
  strategy: "majority_vote",
  topicToRequirement: {
    "t-data-residency": "req-data-residency",
    "t-support-sla": "req-support-sla",
  },
};

// Scripts a client that answers the trigger, the status poll, and the documents
// read in the order the classifier calls them, recording each request.
const scriptedClient = (
  responses: readonly (HttpResponse | (() => Promise<HttpResponse>))[],
): { client: HttpClient; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  let call = 0;
  const client: HttpClient = async (request) => {
    requests.push(request);
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return typeof next === "function" ? next() : next;
  };
  return { client, requests };
};

const classifierFor = (client: HttpClient) =>
  new NumbatchClassifier({
    baseUrl: "http://numbatch-backend:8000/",
    httpClient: client,
    binding,
    // Zero delay so the poll loop does not slow the test.
    pollIntervalMs: 0,
  });

const request = () => ({
  evaluationId: "eval-9",
  responseGroupId: "g1",
  documentIds: ["82f9355e", "5c1a7be0"],
});

describe("NumbatchClassifier — topic → requirement contract", () => {
  it("triggers a run, polls to success, and maps roll-up topics to requirements", async () => {
    const { client } = scriptedClient([
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.documents),
    ]);
    const classifier = classifierFor(client);

    const result = await classifier.classifyResponseGroup(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // Two documents; the first matched two requirements, the second one → 3 rows.
    expect(result.data).toHaveLength(3);
    const first = result.data.find(
      (row) => row.documentId === "82f9355e" && row.requirementId === "req-data-residency",
    );
    expect(first).toBeDefined();
    expect(first!.confidence).toBeCloseTo(0.86);
    // The roll-up is per document, not per chunk — no chunk provenance here.
    expect(first!.sourceChunkId).toBeNull();
  });

  it("posts the trigger with profile, strategy, and the group's documents", async () => {
    const { client, requests } = scriptedClient([
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.documents),
    ]);
    const classifier = classifierFor(client);

    await classifier.classifyResponseGroup(request());

    const trigger = requests[0]!;
    expect(trigger.method).toBe("POST");
    expect(trigger.url).toBe("http://numbatch-backend:8000/batch-inference/trigger");
    expect(trigger.body).toEqual({
      profile_id: binding.profileId,
      strategy: "majority_vote",
      source_doc_ids: ["82f9355e", "5c1a7be0"],
    });
  });

  it("reads the roll-up from the triggered job id", async () => {
    const { client, requests } = scriptedClient([
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.documents),
    ]);
    const classifier = classifierFor(client);

    await classifier.classifyResponseGroup(request());

    expect(requests[1]!.url).toBe(
      `http://numbatch-backend:8000/batch-inference/jobs/${rollup.job.id}`,
    );
    expect(requests[2]!.url).toBe(
      `http://numbatch-backend:8000/batch-inference/jobs/${rollup.job.id}/documents`,
    );
  });

  it("ignores an Unclassified document (empty topics ⇒ no rows)", async () => {
    const documents = [
      { source_doc_id: "82f9355e", status: "Unclassified", topics: [] },
    ];
    const { client } = scriptedClient([
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.job),
      jsonResponse(200, documents),
    ]);
    const classifier = classifierFor(client);

    const result = await classifier.classifyResponseGroup(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(0);
  });

  it("drops a topic with no requirement mapping rather than inventing one", async () => {
    const documents = [
      {
        source_doc_id: "82f9355e",
        status: "Classified",
        topics: [{ topic_id: "t-unmapped", name: "Rogue", score: 0.9, chunks_matched: 3 }],
      },
    ];
    const { client } = scriptedClient([
      jsonResponse(200, rollup.job),
      jsonResponse(200, rollup.job),
      jsonResponse(200, documents),
    ]);
    const classifier = classifierFor(client);

    const result = await classifier.classifyResponseGroup(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(0);
  });

  it("fails with CLASSIFICATION_FAILED when the run ends in failed", async () => {
    const failed = { ...rollup.job, status: "failed", error: "adapter missing" };
    const { client } = scriptedClient([
      jsonResponse(200, rollup.job),
      jsonResponse(200, failed),
    ]);
    const classifier = classifierFor(client);

    const result = await classifier.classifyResponseGroup(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("maps a transport failure to INFRA_FAILURE without throwing", async () => {
    const client: HttpClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const classifier = classifierFor(client);

    const result = await classifier.classifyResponseGroup(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });

  it("maps a non-2xx trigger to a DomainError from the body detail", async () => {
    const { client } = scriptedClient([
      jsonResponse(409, { detail: "an active run already exists for this profile" }),
    ]);
    const classifier = classifierFor(client);

    const result = await classifier.classifyResponseGroup(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("gives up after the poll budget is exhausted while still running", async () => {
    const running = { ...rollup.job, status: "running" };
    const { client } = scriptedClient([
      jsonResponse(200, rollup.job),
      jsonResponse(200, running),
    ]);
    const classifier = new NumbatchClassifier({
      baseUrl: "http://numbatch-backend:8000",
      httpClient: client,
      binding,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    });

    const result = await classifier.classifyResponseGroup(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });
});
