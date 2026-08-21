import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import {
  WomblexAssetReader,
  type HttpClient,
  type HttpResponse,
} from "./womblex-asset-reader";
import shardPages from "./__fixtures__/shard-pages.json";

// The shard pages are captured from the womblex-ingest sidecar's
// GET /runs/{corpus}/{run}/shards/{asset} route against the committed real run
// (services/womblex-ingest/tests/fixtures/run-throsby-demo). The contract this
// adapter holds: those bytes cross into the domain unchanged.

const elementsPage1 = shardPages.elements_page_1;
const elementsPage2 = shardPages.elements_page_2;
const tableCellsEmpty = shardPages.table_cells_empty;

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
  new WomblexAssetReader({ baseUrl: "http://womblex-ingest:8000/", httpClient: client });

describe("WomblexAssetReader — the run-scoped shard seam", () => {
  it("round-trips a real shard page with womblex's own column names, verbatim", async () => {
    const { client } = clientReturning(jsonResponse(200, elementsPage1));
    const reader = readerFor(client);

    const result = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.asset).toBe("elements");
    expect(result.data.runId).toBe("run-throsby-demo");
    expect(result.data.columns.map((column) => column.name)).toEqual(
      elementsPage1.columns.map((column) => column.name),
    );
    const firstRow = result.data.rows[0]!;
    // Womblex's own keys survive; redline's camelCase read model is gone.
    expect(firstRow).toHaveProperty("source_hash");
    expect(firstRow).toHaveProperty("elem_order");
    expect(firstRow).not.toHaveProperty("documentId");
    expect(firstRow).not.toHaveProperty("elementOrder");
  });

  it("passes row values through byte-identical to the shard", async () => {
    const { client } = clientReturning(jsonResponse(200, elementsPage1));
    const reader = readerFor(client);

    const result = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.rows).toEqual(elementsPage1.rows);
  });

  it("reports honest paging: a first page truncates, a second continues where it stopped", async () => {
    const first = await readerFor(clientReturning(jsonResponse(200, elementsPage1)).client).readShard(
      { corpusId: "throsby", runId: "run-throsby-demo", asset: "elements", limit: 20, offset: 0 },
    );
    const second = await readerFor(clientReturning(jsonResponse(200, elementsPage2)).client).readShard(
      { corpusId: "throsby", runId: "run-throsby-demo", asset: "elements", limit: 20, offset: 20 },
    );

    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.data.returned).toBe(20);
    expect(first.data.available).toBe(24);
    expect(first.data.truncated).toBe(true);
    expect(second.data.returned).toBe(4);
    expect(second.data.truncated).toBe(false);
    // The second page's rows do not repeat the first page's.
    expect(second.data.rows).toEqual(elementsPage2.rows);
  });

  it("serves an empty asset with its columns — no rows, not no such asset", async () => {
    const { client } = clientReturning(jsonResponse(200, tableCellsEmpty));
    const reader = readerFor(client);

    const result = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "table_cells",
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.rows).toEqual([]);
    expect(result.data.columns.map((column) => column.name)).toContain("parent_elem_order");
  });

  it("builds the run-scoped URL, URL-encoding ids and passing the page window", async () => {
    const { client, urls } = clientReturning(jsonResponse(200, elementsPage1));
    const reader = readerFor(client);

    await reader.readShard({
      corpusId: "cor pus",
      runId: "run-throsby-demo",
      asset: "elements",
      documentId: "a/b",
      limit: 20,
      offset: 40,
    });

    expect(urls).toEqual([
      "http://womblex-ingest:8000/runs/cor%20pus/run-throsby-demo/shards/elements" +
        "?documentId=a%2Fb&limit=20&offset=40",
    ]);
  });

  it("omits query parameters that were not asked for", async () => {
    const { client, urls } = clientReturning(jsonResponse(200, elementsPage1));
    const reader = readerFor(client);

    await reader.readShard({ corpusId: "throsby", runId: "run-throsby-demo", asset: "elements" });

    expect(urls).toEqual([
      "http://womblex-ingest:8000/runs/throsby/run-throsby-demo/shards/elements",
    ]);
  });

  it("maps the sidecar's NOT_FOUND body to a NOT_FOUND DomainError", async () => {
    const { client } = clientReturning(
      jsonResponse(404, { error: { code: "NOT_FOUND", message: "no such asset" } }),
    );
    const reader = readerFor(client);

    const result = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "not_an_asset",
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("maps a transport failure to INFRA_FAILURE without throwing", async () => {
    const client: HttpClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const reader = readerFor(client);

    const result = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });

  it("maps a malformed payload to EXTRACTION_FAILED", async () => {
    const { client } = clientReturning(
      jsonResponse(200, { asset: "elements", runId: "r", columns: "nope", rows: [] }),
    );
    const reader = readerFor(client);

    const result = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
    });

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

    const result = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
  });
});
