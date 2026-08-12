import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import type { StagedUpload } from "@redline/redline-domain";
import { MinioStagedCorpusWriter, type StagedCorpusPutClient } from "./minio-staged-corpus-writer";

// The write adapter's contract. It is "as if C" over the minio client: the only
// code at redline's first write-side object-store seam. The client is injected
// so the contract is proven without mocking the minio module — a recorder that
// captures what would reach the bucket, exactly as the read adapters inject a
// structural db.
//
// The load-bearing assertion is the KEY. womblex's runner resolves its input
// from `proc/{evaluationId}/inputs/`, so a byte staged under any other prefix is
// a byte the run never reads. The adapter owns that layout; the domain port
// declares it, this proves the adapter honours it against a real client shape.

interface Put {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
}

class RecordingClient implements StagedCorpusPutClient {
  readonly puts: Put[] = [];
  failOnKey: string | null = null;

  async putObject(
    bucket: string,
    key: string,
    data: Buffer,
    size: number,
    metadata: { "Content-Type": string },
  ): Promise<{ etag: string }> {
    if (key === this.failOnKey) {
      throw new Error("bucket refused the object");
    }
    this.puts.push({ bucket, key, size, contentType: metadata["Content-Type"] });
    return { etag: "recorded" };
  }
}

const upload = (over: Partial<StagedUpload> & { fileName: string }): StagedUpload => ({
  bytes: new Uint8Array([1, 2, 3, 4]),
  contentType: "application/pdf",
  ...over,
});

const makeWriter = (client: RecordingClient) =>
  new MinioStagedCorpusWriter({ client, bucket: "redline" });

describe("MinioStagedCorpusWriter — the write side of the object-store seam", () => {
  it("puts bytes at proc/{evaluationId}/inputs/{fileName} in the configured bucket", async () => {
    const client = new RecordingClient();
    const writer = makeWriter(client);

    const staged = await writer.stage("tender-2026-water", upload({ fileName: "alpha.pdf" }));

    expect(isOk(staged)).toBe(true);
    if (!isOk(staged)) return;
    expect(staged.data.key).toBe("proc/tender-2026-water/inputs/alpha.pdf");
    expect(client.puts).toEqual([
      {
        bucket: "redline",
        key: "proc/tender-2026-water/inputs/alpha.pdf",
        size: 4,
        contentType: "application/pdf",
      },
    ]);
  });

  it("sends the exact byte length so the client streams the whole object, not a truncated one", async () => {
    const client = new RecordingClient();
    const writer = makeWriter(client);

    await writer.stage(
      "tender",
      upload({ fileName: "big.xlsx", bytes: new Uint8Array(2048), contentType: "application/vnd.ms-excel" }),
    );

    expect(client.puts[0]?.size).toBe(2048);
    expect(client.puts[0]?.contentType).toBe("application/vnd.ms-excel");
  });

  it("returns INFRA_FAILURE when the client throws, rather than letting the exception cross the seam", async () => {
    const client = new RecordingClient();
    client.failOnKey = "proc/tender/inputs/gamma.pdf";
    const writer = makeWriter(client);

    const staged = await writer.stage("tender", upload({ fileName: "gamma.pdf" }));

    expect(isErr(staged)).toBe(true);
    if (!isErr(staged)) return;
    expect(staged.error.code).toBe("INFRA_FAILURE");
  });

  it("refuses an empty evaluation id before touching the bucket", async () => {
    const client = new RecordingClient();
    const writer = makeWriter(client);

    const staged = await writer.stage("", upload({ fileName: "x.pdf" }));

    expect(isErr(staged)).toBe(true);
    if (!isErr(staged)) return;
    expect(staged.error.code).toBe("VALIDATION_FAILED");
    expect(client.puts).toEqual([]);
  });

  it("refuses a file name that would escape the evaluation's prefix", async () => {
    const client = new RecordingClient();
    const writer = makeWriter(client);

    const staged = await writer.stage("tender", upload({ fileName: "../other/evil.pdf" }));

    expect(isErr(staged)).toBe(true);
    if (!isErr(staged)) return;
    expect(staged.error.code).toBe("VALIDATION_FAILED");
    expect(client.puts).toEqual([]);
  });
});
