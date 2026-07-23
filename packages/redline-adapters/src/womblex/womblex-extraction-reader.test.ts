import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import {
  WomblexExtractionReader,
  type HttpClient,
  type HttpResponse,
} from "./womblex-extraction-reader";
import fixture from "./__fixtures__/extraction-tender.pdf.json";

// A real run's read-seam payload, captured from the womblex-ingest sidecar's
// GET /extractions/{eval}/{doc} response (see __fixtures__/README.md). The
// contract: this adapter turns that JSON into the domain's typed provenance.

const jsonResponse = (status: number, body: unknown): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Records the URL the reader requested so we can assert the seam contract.
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
  new WomblexExtractionReader({ baseUrl: "http://womblex-ingest:8000/", httpClient: client });

describe("WomblexExtractionReader — Parquet→JSON contract", () => {
  it("reads elements from a real run into typed provenance", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    const result = await reader.readElements("eval-9", "tender.pdf");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.length).toBeGreaterThan(0);
    const first = result.data[0]!;
    expect(first.documentId).toBe(fixture.documentId);
    expect(first.elementOrder).toBe(0);
    expect(typeof first.text).toBe("string");
  });

  it("reads chunks with womblex chunkId provenance ({source_hash}:{index})", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    const result = await reader.readChunks("eval-9", "tender.pdf");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const chunk = result.data[0]!;
    expect(chunk.chunkId.startsWith(`${chunk.documentId}:`)).toBe(true);
  });

  it("reads currency-typed table cells", async () => {
    const { client } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    const result = await reader.readTableCells("eval-9", "tender.pdf");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const currency = result.data.find((c) => c.isCurrency);
    expect(currency).toBeDefined();
    expect(typeof currency!.rawValue).toBe("string");
  });

  it("requests the document-scoped read-seam URL, URL-encoding the ids", async () => {
    const { client, urls } = clientReturning(jsonResponse(200, fixture));
    const reader = readerFor(client);

    await reader.readElements("eval 9", "a/b.pdf");

    expect(urls).toEqual(["http://womblex-ingest:8000/extractions/eval%209/a%2Fb.pdf"]);
  });

  it("maps the sidecar's NOT_FOUND body to a NOT_FOUND DomainError", async () => {
    const { client } = clientReturning(
      jsonResponse(404, { error: { code: "NOT_FOUND", message: "no extraction" } }),
    );
    const reader = readerFor(client);

    const result = await reader.readElements("eval-9", "missing.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("maps a transport failure to INFRA_FAILURE without throwing", async () => {
    const client: HttpClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const reader = readerFor(client);

    const result = await reader.readChunks("eval-9", "tender.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });

  it("maps a malformed payload to EXTRACTION_FAILED", async () => {
    const { client } = clientReturning(
      jsonResponse(200, { documentId: "x", elements: [{ nope: true }], chunks: [], tableCells: [] }),
    );
    const reader = readerFor(client);

    const result = await reader.readElements("eval-9", "tender.pdf");

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

    const result = await reader.readTableCells("eval-9", "tender.pdf");

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
  });
});
