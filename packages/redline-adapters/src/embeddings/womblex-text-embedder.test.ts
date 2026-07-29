import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import {
  WomblexTextEmbedder,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "./womblex-text-embedder";
import fixture from "./__fixtures__/query-embedding.json";

// A captured POST /embeddings/query response from the womblex-ingest sidecar
//. The contract: this adapter turns that JSON into the domain's
// QueryEmbedding, parsing `values` into a Float32Array in the *same* declared
// space as the chunk vectors the extraction reader returns (ADR-0014), so
// Thread 22 can match a topic definition against a document by dot product.

const jsonResponse = (status: number, body: unknown): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const clientReturning = (
  response: HttpResponse | (() => Promise<HttpResponse>),
): { client: HttpClient; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const client: HttpClient = async (request) => {
    requests.push(request);
    return typeof response === "function" ? response() : response;
  };
  return { client, requests };
};

const embedderFor = (client: HttpClient) =>
  new WomblexTextEmbedder({ baseUrl: "http://womblex-ingest:8000/", httpClient: client });

describe("WomblexTextEmbedder — query-embedding-seam contract", () => {
  it("embeds text into a QueryEmbedding with Float32Array values", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const embedder = embedderFor(client);

    const result = await embedder.embed("network security controls");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.model).toBe("stub-deterministic-v1");
    expect(result.data.dimensions).toBe(8);
    expect(result.data.values).toBeInstanceOf(Float32Array);
    expect(result.data.values.length).toBe(result.data.dimensions);
  });

  it("keeps the query vector L2-normalised across the parse (a dot product downstream)", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const embedder = embedderFor(client);

    const result = await embedder.embed("network security controls");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    let sumOfSquares = 0;
    for (const value of result.data.values) sumOfSquares += value * value;
    expect(Math.sqrt(sumOfSquares)).toBeCloseTo(1, 4);
  });

  it("POSTs the text to the query seam", async () => {
    const { client, requests } = clientReturning(jsonResponse(200, fixture));
    const embedder = embedderFor(client);

    await embedder.embed("network security controls");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("http://womblex-ingest:8000/embeddings/query");
    expect(requests[0]?.body).toEqual({ text: "network security controls" });
  });

  it("caches by text: the same definition embeds once", async () => {
    const { client, requests } = clientReturning(jsonResponse(200, fixture));
    const embedder = embedderFor(client);

    await embedder.embed("network security controls");
    await embedder.embed("network security controls");

    expect(requests).toHaveLength(1);
  });

  it("does not conflate distinct texts in the cache", async () => {
    const { client, requests } = clientReturning(jsonResponse(200, fixture));
    const embedder = embedderFor(client);

    await embedder.embed("network security controls");
    await embedder.embed("data retention policy");

    expect(requests).toHaveLength(2);
  });

  it("rejects blank text before any round trip", async () => {
    const { client, requests } = clientReturning(jsonResponse(200, fixture));
    const embedder = embedderFor(client);

    const result = await embedder.embed("   ");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    // No request was made — the caller mistake is caught locally.
    expect(requests).toHaveLength(0);
  });

  it("maps the sidecar's INVALID_REQUEST body to VALIDATION_FAILED", async () => {
    const { client } = clientReturning(
      jsonResponse(422, { error: { code: "INVALID_REQUEST", message: "text must not be empty" } }),
    );
    const embedder = embedderFor(client);

    // A non-blank text the adapter forwards, which the sidecar still rejects.
    const result = await embedder.embed("something");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("maps a transport failure to INFRA_FAILURE without throwing", async () => {
    const client: HttpClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const embedder = embedderFor(client);

    const result = await embedder.embed("network security controls");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });

  it("does not cache a failed embed", async () => {
    let attempt = 0;
    const client: HttpClient = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ECONNREFUSED");
      return jsonResponse(200, fixture);
    };
    const embedder = embedderFor(client);

    const failed = await embedder.embed("network security controls");
    const retried = await embedder.embed("network security controls");

    expect(isErr(failed)).toBe(true);
    expect(isOk(retried)).toBe(true);
  });

  it("rejects a query vector that disagrees with its declared dimensions", async () => {
    const { client } = clientReturning(
      jsonResponse(200, { model: "m", dimensions: 3, values: [0.6, 0.8] }),
    );
    const embedder = embedderFor(client);

    const result = await embedder.embed("network security controls");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("maps a non-JSON body to INFRA_FAILURE", async () => {
    const { client } = clientReturning({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });
    const embedder = embedderFor(client);

    const result = await embedder.embed("network security controls");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });
});
