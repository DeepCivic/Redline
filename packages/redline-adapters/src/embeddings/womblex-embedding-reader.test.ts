import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import {
  WomblexEmbeddingReader,
  type HttpClient,
  type HttpResponse,
} from "./womblex-embedding-reader";
import fixture from "./__fixtures__/embeddings-tender.pdf.json";

// A real run's retrieval-seam payload, captured from the womblex-ingest sidecar's
// GET /embeddings/{eval}/{doc} response (see __fixtures__/README.md). The
// contract: this adapter turns that JSON into the domain's DocumentEmbeddings,
// with the vectors parsed into Float32Array (ADR-0014).

const jsonResponse = (status: number, body: unknown): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const clientReturning = (
  response: HttpResponse | (() => Promise<HttpResponse>),
): { client: HttpClient; urls: string[] } => {
  const urls: string[] = [];
  const client: HttpClient = async (url) => {
    urls.push(url);
    return typeof response === "function" ? response() : response;
  };
  return { client, urls };
};

const readerFor = (client: HttpClient) =>
  new WomblexEmbeddingReader({ baseUrl: "http://womblex-ingest:8000/", httpClient: client });

describe("WomblexEmbeddingReader — retrieval-seam contract", () => {
  it("reads a document's vectors as Float32Array", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.documentId).toBe(fixture.documentId);
    expect(result.data.model).toBe("stub-deterministic-v1");
    expect(result.data.dimensions).toBe(8);
    const vector = result.data.vectors[0]!;
    expect(vector.values).toBeInstanceOf(Float32Array);
    expect(vector.values.length).toBe(result.data.dimensions);
  });

  it("preserves the chunkId join key ({source_hash}:{index}) and the ordinal", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const vector = result.data.vectors[0]!;
    const [sourceHash, chunkIndex] = vector.chunkId.split(":");
    expect(sourceHash).toBe(result.data.documentId);
    expect(Number(chunkIndex)).toBe(vector.chunkIndex);
  });

  it("keeps vectors L2-normalised across the parse (a dot product downstream)", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const values = result.data.vectors[0]!.values;
    let sumOfSquares = 0;
    for (const value of values) sumOfSquares += value * value;
    // Float32 precision widens the tolerance from the double-precision producer.
    expect(Math.sqrt(sumOfSquares)).toBeCloseTo(1, 4);
  });

  it("requests the document-scoped read-seam URL, URL-encoding the ids", async () => {
    const { client, urls } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    await reader.readEmbeddings("eval 9", "a/b.pdf");

    expect(urls).toEqual(["http://womblex-ingest:8000/embeddings/eval%209/a%2Fb.pdf"]);
  });

  it("caches per (evaluation, document): immutable vectors are fetched once", async () => {
    const { client, urls } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    const first = await reader.readEmbeddings("eval-9", "tender.pdf");
    const second = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isOk(first) && isOk(second)).toBe(true);
    // Vectors are content-addressed and immutable, so the transfer is payable
    // once per evaluation, not once per classification run (ADR-0014).
    expect(urls).toHaveLength(1);
  });

  it("does not conflate documents in the cache", async () => {
    const { client, urls } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    await reader.readEmbeddings("eval-9", "tender.pdf");
    await reader.readEmbeddings("eval-9", "other.pdf");
    await reader.readEmbeddings("eval-other", "tender.pdf");

    expect(urls).toHaveLength(3);
  });

  it("does not cache a failed read", async () => {
    let attempt = 0;
    const client: HttpClient = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ECONNREFUSED");
      return jsonResponse(200, fixture);
    };
    const reader = readerFor(client);

    const failed = await reader.readEmbeddings("eval-9", "tender.pdf");
    const retried = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isErr(failed)).toBe(true);
    expect(isOk(retried)).toBe(true);
  });

  it("maps the sidecar's NOT_FOUND body to a NOT_FOUND DomainError", async () => {
    const { client } = clientReturning(
      jsonResponse(404, { error: { code: "NOT_FOUND", message: "no embeddings" } }),
    );
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "missing.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("maps a transport failure to INFRA_FAILURE without throwing", async () => {
    const client: HttpClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });

  it("maps a malformed payload to EXTRACTION_FAILED", async () => {
    const { client } = clientReturning(
      jsonResponse(200, {
        documentId: "x",
        model: "m",
        dimensions: 2,
        vectors: [{ chunkId: "x:0", chunkIndex: 0, values: ["not", "numbers"] }],
      }),
    );
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
  });

  it("rejects a payload whose vectors disagree with the declared dimensions", async () => {
    const { client } = clientReturning(
      jsonResponse(200, {
        documentId: "x",
        model: "m",
        dimensions: 3,
        vectors: [{ chunkId: "x:0", chunkIndex: 0, values: [0.6, 0.8] }],
      }),
    );
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
  });

  it("maps a non-JSON body to EXTRACTION_FAILED", async () => {
    const { client } = clientReturning({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });
    const reader = readerFor(client);

    const result = await reader.readEmbeddings("eval-9", "tender.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
  });
});
