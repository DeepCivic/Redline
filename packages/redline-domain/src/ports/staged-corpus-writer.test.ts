import { describe, it, expect } from "vitest";
import { isOk, isErr, err, ok, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import type {
  IStagedCorpusWriter,
  StagedUpload,
} from "./staged-corpus-writer";

// The write half's spec. Until now every object-store seam in redline was a
// read: the engine wrote shards and redline read them back. This port is the
// first write — it puts a specialist's chosen bytes under `proc/{evaluationId}/`
// so the womblex run has an input, without a terminal `mc cp` in the loop.
//
// It stages bytes only. It does not process them, mint a source_hash (womblex
// does that when it extracts), or decide document identity — the object key is
// the specialist's file name under the evaluation's prefix, and womblex reads
// the same prefix its own smoke path already stages into
// (`proc/{evaluationId}/inputs/`).

// A dependency-free in-memory writer over the (key -> bytes) map a bucket holds.
// The keys it records are asserted directly, because the prefix is the contract:
// womblex's runner resolves its input from `proc/{evaluationId}/inputs/`, so a
// byte staged anywhere else is a byte the run never sees.
class InMemoryStagedCorpusWriter implements IStagedCorpusWriter {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  rejectFileName: string | null = null;

  async stage(
    evaluationId: string,
    upload: StagedUpload,
  ): Promise<Result<{ readonly key: string }>> {
    if (evaluationId.length === 0) {
      return err(domainError("VALIDATION_FAILED", "evaluationId must be non-empty"));
    }

    if (upload.fileName.length === 0) {
      return err(domainError("VALIDATION_FAILED", "fileName must be non-empty"));
    }

    if (upload.fileName === this.rejectFileName) {
      return err(domainError("INFRA_FAILURE", `bucket refused ${upload.fileName}`));
    }

    const key = `proc/${evaluationId}/inputs/${upload.fileName}`;
    this.objects.set(key, { bytes: upload.bytes, contentType: upload.contentType });
    return ok({ key });
  }
}

const upload = (over: Partial<StagedUpload> & { fileName: string }): StagedUpload => ({
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "application/pdf",
  ...over,
});

describe("IStagedCorpusWriter — staging bytes a womblex run reads back", () => {
  it("stages a document under the evaluation's input prefix and returns its key", async () => {
    const writer = new InMemoryStagedCorpusWriter();

    const staged = await writer.stage("tender-2026-water", upload({ fileName: "alpha.pdf" }));

    expect(isOk(staged)).toBe(true);
    if (!isOk(staged)) return;
    expect(staged.data.key).toBe("proc/tender-2026-water/inputs/alpha.pdf");
    expect(writer.objects.has("proc/tender-2026-water/inputs/alpha.pdf")).toBe(true);
  });

  it("carries the bytes and content type through unaltered — it stages, it does not process", async () => {
    const writer = new InMemoryStagedCorpusWriter();
    const bytes = new Uint8Array([9, 8, 7, 6]);

    await writer.stage(
      "tender-2026-roads",
      upload({ fileName: "beta.xlsx", bytes, contentType: "application/vnd.ms-excel" }),
    );

    const object = writer.objects.get("proc/tender-2026-roads/inputs/beta.xlsx");
    expect(object?.bytes).toBe(bytes);
    expect(object?.contentType).toBe("application/vnd.ms-excel");
  });

  it("refuses an empty evaluation id, so a byte cannot land under a prefix no run reads", async () => {
    const staged = await new InMemoryStagedCorpusWriter().stage("", upload({ fileName: "x.pdf" }));

    expect(isErr(staged)).toBe(true);
    if (!isErr(staged)) return;
    expect(staged.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses an empty file name, so a staged object always has a key a run can address", async () => {
    const staged = await new InMemoryStagedCorpusWriter().stage("tender", upload({ fileName: "" }));

    expect(isErr(staged)).toBe(true);
    if (!isErr(staged)) return;
    expect(staged.error.code).toBe("VALIDATION_FAILED");
  });

  it("surfaces a bucket failure as INFRA_FAILURE rather than throwing across the seam", async () => {
    const writer = new InMemoryStagedCorpusWriter();
    writer.rejectFileName = "gamma.pdf";

    const staged = await writer.stage("tender", upload({ fileName: "gamma.pdf" }));

    expect(isErr(staged)).toBe(true);
    if (!isErr(staged)) return;
    expect(staged.error.code).toBe("INFRA_FAILURE");
  });
});
