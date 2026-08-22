import { describe, it, expect } from "vitest";
import { isErr, isOk } from "@redline/redline-domain";
import { WomblexShapeReader } from "./womblex-shape-reader";
import type { HttpResponse } from "./womblex-asset-reader";
import capture from "./__fixtures__/corpus-shape.json";

// The shape read against a real capture. `__fixtures__/corpus-shape.json` is the
// sidecar's own `/shape` output over
// services/womblex-ingest/tests/fixtures/run-throsby-demo — a real womblex run —
// at all three scopes, so a field this adapter reads under a name the sidecar
// does not serve fails here rather than surfacing as an empty value.

const DOCUMENT_ID = "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54";

const scopeFor = (url: string): unknown => {
  if (url.includes("documentId=")) return capture.document;
  if (/\/runs\/[^/]+\/[^/]+\/shape/.test(url)) return capture.run;
  return capture.corpus;
};

const capturedHttpClient = async (url: string): Promise<HttpResponse> => ({
  ok: true,
  status: 200,
  json: async () => scopeFor(url),
});

const readerOver = (httpClient: (url: string) => Promise<HttpResponse>) =>
  new WomblexShapeReader({ baseUrl: "http://womblex-ingest.invalid", httpClient });

const urlsSeenBy = (urls: string[]) =>
  readerOver(async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => scopeFor(url) };
  });

describe("WomblexShapeReader", () => {
  it("reads a run's per-asset row counts from the real capture", async () => {
    const shape = await readerOver(capturedHttpClient).readShape({
      corpusId: "throsby",
      runId: "run-throsby-demo",
    });

    expect(isOk(shape)).toBe(true);
    if (!isOk(shape)) return;
    const assets = shape.data.runs[0]!.assets;
    const rowsFor = (name: string) => assets.find((asset) => asset.name === name)?.rows;
    expect(rowsFor("elements")).toBe(24);
    expect(rowsFor("chunks")).toBe(4);
    expect(rowsFor("entities")).toBe(34);
    expect(rowsFor("graph_edges")).toBe(156);
    expect(rowsFor("money_spans")).toBe(2);
  });

  it("keeps two runs of one corpus apart", async () => {
    const shape = await readerOver(capturedHttpClient).readShape({ corpusId: "throsby" });

    expect(isOk(shape)).toBe(true);
    if (!isOk(shape)) return;
    expect(shape.data.runs.map((run) => run.runId)).toEqual([
      "run-throsby-demo",
      "run-20260101T000000Z",
    ]);
    // The older run landed extraction only, so its enrichment shards are absent
    // rather than empty — a distinction that decides the client's next call.
    const older = shape.data.runs[1]!.assets.find((asset) => asset.name === "entities")!;
    expect(older.present).toBe(false);
  });

  it("carries the document's tallies and page range", async () => {
    const shape = await readerOver(capturedHttpClient).readShape({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      documentId: DOCUMENT_ID,
    });

    expect(isOk(shape)).toBe(true);
    if (!isOk(shape)) return;
    const elements = shape.data.runs[0]!.assets.find((asset) => asset.name === "elements")!;
    expect(elements.values.kind!.counts[0]).toEqual({ value: "paragraph", rows: 15 });
    expect(elements.values.kind!.truncated).toBe(false);
    expect(elements.ranges.page).toEqual({ min: 0, max: 2 });
  });

  it("carries an unreadable asset as counted-not-at-all rather than zero", async () => {
    const shape = await readerOver(capturedHttpClient).readShape({
      corpusId: "throsby",
      runId: "run-throsby-demo",
    });

    expect(isOk(shape)).toBe(true);
    if (!isOk(shape)) return;
    const embeddings = shape.data.runs[0]!.assets.find(
      (asset) => asset.name === "embeddings",
    )!;
    expect(embeddings.readable).toBe(false);
    expect(embeddings.rows).toBeNull();
  });

  it("addresses the corpus scope without naming a run", async () => {
    const urls: string[] = [];

    await urlsSeenBy(urls).readShape({ corpusId: "throsby" });

    expect(urls).toEqual(["http://womblex-ingest.invalid/runs/throsby/shape"]);
  });

  it("addresses a document within its run", async () => {
    const urls: string[] = [];

    await urlsSeenBy(urls).readShape({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      documentId: DOCUMENT_ID,
    });

    expect(urls).toEqual([
      `http://womblex-ingest.invalid/runs/throsby/run-throsby-demo/shape?documentId=${DOCUMENT_ID}`,
    ]);
  });

  it("refuses a document it cannot address, rather than sizing the corpus", async () => {
    const urls: string[] = [];

    const shape = await urlsSeenBy(urls).readShape({
      corpusId: "throsby",
      documentId: DOCUMENT_ID,
    });

    expect(isErr(shape)).toBe(true);
    if (!isErr(shape)) return;
    expect(shape.error.code).toBe("VALIDATION_FAILED");
    expect(urls).toEqual([]);
  });

  it("returns INFRA_FAILURE when the sidecar is unreachable", async () => {
    const reader = readerOver(async () => {
      throw new Error("ECONNREFUSED");
    });

    const shape = await reader.readShape({ corpusId: "throsby" });

    expect(isErr(shape)).toBe(true);
    if (!isErr(shape)) return;
    expect(shape.error.code).toBe("INFRA_FAILURE");
  });

  it("maps the sidecar's own error body onto a domain error", async () => {
    const reader = readerOver(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "NOT_FOUND", message: "no such corpus" } }),
    }));

    const shape = await reader.readShape({ corpusId: "missing" });

    expect(isErr(shape)).toBe(true);
    if (!isErr(shape)) return;
    expect(shape.error.code).toBe("NOT_FOUND");
  });

  it("refuses a body that is not shaped like a corpus shape", async () => {
    const reader = readerOver(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ corpusId: "throsby", runs: "not an array" }),
    }));

    const shape = await reader.readShape({ corpusId: "throsby" });

    expect(isErr(shape)).toBe(true);
    if (!isErr(shape)) return;
    expect(shape.error.code).toBe("EXTRACTION_FAILED");
  });

  it("refuses an asset entry whose row count is not a number or null", async () => {
    const reader = readerOver(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        corpusId: "throsby",
        runId: null,
        documentId: null,
        documents: 1,
        runs: [
          {
            runId: "run-throsby-demo",
            versioned: true,
            documents: 1,
            assets: [
              {
                name: "elements",
                present: true,
                readable: true,
                rows: "24",
                columns: [],
                values: {},
                ranges: {},
              },
            ],
          },
        ],
      }),
    }));

    const shape = await reader.readShape({ corpusId: "throsby" });

    expect(isErr(shape)).toBe(true);
    if (!isErr(shape)) return;
    expect(shape.error.code).toBe("EXTRACTION_FAILED");
  });
});
