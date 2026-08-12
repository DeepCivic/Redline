import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import {
  HttpWomblexRunTrigger,
  type RunTriggerHttpClient,
  type RunTriggerHttpRequest,
  type RunTriggerHttpResponse,
} from "./http-womblex-run-trigger";

// The run-trigger adapter's contract, proven against a recording fake of the
// sidecar's two JSON endpoints (`POST /runs`, `GET /runs/{runId}`,
// `POST /runs/{runId}/resume`) — no live sidecar. The adapter is "as if C": its
// only coupling to the engine is HTTP + JSON, and no driver exception ever
// crosses the port edge.

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body?: unknown;
}

class FakeSidecar {
  readonly calls: Recorded[] = [];
  responses: RunTriggerHttpResponse[] = [];
  throwOn: string | null = null;

  client: RunTriggerHttpClient = async (request: RunTriggerHttpRequest) => {
    this.calls.push({ url: request.url, method: request.method, body: request.body });
    if (this.throwOn !== null && request.url.includes(this.throwOn)) {
      throw new Error("sidecar unreachable");
    }
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error(`no queued response for ${request.method} ${request.url}`);
    }
    return next;
  };

  queue(status: number, body: unknown): void {
    this.responses.push({ ok: status >= 200 && status < 300, status, json: async () => body });
  }
}

const BASE = "http://womblex-ingest:8000";

const trigger = (sidecar: FakeSidecar): HttpWomblexRunTrigger =>
  new HttpWomblexRunTrigger({ baseUrl: BASE, httpClient: sidecar.client });

describe("HttpWomblexRunTrigger — the run seam over the sidecar's JSON endpoints", () => {
  it("POSTs the evaluation id and stage sequence to /runs and returns the run id", async () => {
    const sidecar = new FakeSidecar();
    sidecar.queue(202, { runId: "run-7", evaluationId: "tender-water" });

    const started = await trigger(sidecar).start({
      evaluationId: "tender-water",
      stageSequence: ["chunk", "embed", "enrich", "money"],
    });

    expect(isOk(started)).toBe(true);
    if (!isOk(started)) return;
    expect(started.data.runId).toBe("run-7");
    expect(sidecar.calls[0]?.method).toBe("POST");
    expect(sidecar.calls[0]?.url).toBe(`${BASE}/runs`);
    expect(sidecar.calls[0]?.body).toEqual({
      evaluationId: "tender-water",
      stageSequence: ["chunk", "embed", "enrich", "money"],
    });
  });

  it("maps a done run's status into the view model a poller binds to", async () => {
    const sidecar = new FakeSidecar();
    sidecar.queue(200, {
      runId: "run-7",
      evaluationId: "tender-water",
      phase: "done",
      completedStages: ["chunk", "embed", "enrich", "money"],
      failedStage: null,
      resumable: false,
      error: null,
    });

    const view = await trigger(sidecar).status("run-7");

    expect(isOk(view)).toBe(true);
    if (!isOk(view)) return;
    expect(view.data.phase).toBe("done");
    expect(view.data.completedStages).toEqual(["chunk", "embed", "enrich", "money"]);
    expect(view.data.failedStage).toBeNull();
    expect(sidecar.calls[0]?.method).toBe("GET");
    expect(sidecar.calls[0]?.url).toBe(`${BASE}/runs/run-7`);
  });

  it("maps an errored run's status — the failed stage, the reason, and resumable", async () => {
    const sidecar = new FakeSidecar();
    sidecar.queue(200, {
      runId: "run-7",
      evaluationId: "tender-water",
      phase: "errored",
      completedStages: ["chunk"],
      failedStage: "embed",
      resumable: true,
      error: "embed pass exhausted retries",
    });

    const view = await trigger(sidecar).status("run-7");

    expect(isOk(view)).toBe(true);
    if (!isOk(view)) return;
    expect(view.data.phase).toBe("errored");
    expect(view.data.failedStage).toBe("embed");
    expect(view.data.resumable).toBe(true);
    expect(view.data.error).toBe("embed pass exhausted retries");
    expect(view.data.completedStages).toEqual(["chunk"]);
  });

  it("resumes a run by POSTing to /runs/{runId}/resume", async () => {
    const sidecar = new FakeSidecar();
    sidecar.queue(202, { runId: "run-7", evaluationId: "tender-water" });

    const resumed = await trigger(sidecar).resume("run-7");

    expect(isOk(resumed)).toBe(true);
    if (!isOk(resumed)) return;
    expect(resumed.data.runId).toBe("run-7");
    expect(sidecar.calls[0]?.method).toBe("POST");
    expect(sidecar.calls[0]?.url).toBe(`${BASE}/runs/run-7/resume`);
  });

  it("maps the sidecar's 404 for an unknown run into NOT_FOUND", async () => {
    const sidecar = new FakeSidecar();
    sidecar.queue(404, { error: { code: "RUN_NOT_FOUND", message: "no run with id run-x" } });

    const view = await trigger(sidecar).status("run-x");

    expect(isErr(view)).toBe(true);
    if (!isErr(view)) return;
    expect(view.error.code).toBe("NOT_FOUND");
  });

  it("maps the sidecar's 422 for an off-list stage into VALIDATION_FAILED", async () => {
    const sidecar = new FakeSidecar();
    sidecar.queue(422, { error: { code: "INVALID_REQUEST", message: "'link' is not authorable" } });

    const started = await trigger(sidecar).start({
      evaluationId: "tender-water",
      // A stage outside the port's type would be a compile error; the runtime
      // guard is the sidecar's, and its refusal maps to VALIDATION_FAILED here.
      stageSequence: ["chunk", "embed"],
    });

    expect(isErr(started)).toBe(true);
    if (!isErr(started)) return;
    expect(started.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns INFRA_FAILURE rather than throwing when the sidecar is unreachable", async () => {
    const sidecar = new FakeSidecar();
    sidecar.throwOn = "/runs";

    const started = await trigger(sidecar).start({
      evaluationId: "tender-water",
      stageSequence: ["chunk", "embed"],
    });

    expect(isErr(started)).toBe(true);
    if (!isErr(started)) return;
    expect(started.error.code).toBe("INFRA_FAILURE");
  });

  it("returns EXTRACTION_FAILED when the sidecar's status body is malformed", async () => {
    const sidecar = new FakeSidecar();
    sidecar.queue(200, { runId: "run-7" }); // missing phase / evaluationId

    const view = await trigger(sidecar).status("run-7");

    expect(isErr(view)).toBe(true);
    if (!isErr(view)) return;
    expect(view.error.code).toBe("EXTRACTION_FAILED");
  });
});
