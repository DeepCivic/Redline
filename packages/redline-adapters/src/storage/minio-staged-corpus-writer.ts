// MinioStagedCorpusWriter — redline's first write-side object-store adapter, the
// only code at that seam. It implements IStagedCorpusWriter over the minio
// client the fork already carries, putting a specialist's chosen bytes under
// `proc/{evaluationId}/inputs/{fileName}` in redline's own bucket — the prefix
// the womblex runner resolves its input from (scripts/womblex-engine-smoke.sh
// stages into the same place). Every method returns a Result and no client
// exception crosses the port.
//
// The seam stays plain S3 (architecture §5 invariant 2 / ADR-0002): redline owns
// the bucket, the client is path-style for MinIO and repoints at AWS by config.
// The client is injected so the adapter is testable without a live bucket and so
// the fork's own MinIO client construction stays the fork's, not restated here.

import {
  domainError,
  err,
  ok,
  type IStagedCorpusWriter,
  type Result,
  type StagedUpload,
} from "@redline/redline-domain";

// The minio surface this adapter uses — just putObject, kept structural so a
// real `minio` Client satisfies it without a driver import in the domain or the
// test. The signature mirrors minio's own (bucket, key, data, size, metadata).
export interface StagedCorpusPutClient {
  putObject(
    bucket: string,
    key: string,
    data: Buffer,
    size: number,
    metadata: { "Content-Type": string },
  ): Promise<{ etag: string }>;
}

export interface MinioStagedCorpusWriterOptions {
  readonly client: StagedCorpusPutClient;
  readonly bucket: string;
}

// womblex reads its input from here; a file name that could climb out of the
// prefix (a slash or a parent segment) would stage bytes a different evaluation
// then reads, so the key layout is enforced rather than trusted.
const escapesPrefix = (fileName: string): boolean =>
  fileName.includes("/") || fileName.includes("\\") || fileName.includes("..");

export class MinioStagedCorpusWriter implements IStagedCorpusWriter {
  private readonly client: StagedCorpusPutClient;
  private readonly bucket: string;

  constructor(options: MinioStagedCorpusWriterOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
  }

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

    if (escapesPrefix(upload.fileName)) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          `fileName ${upload.fileName} must be a leaf name under the evaluation's prefix`,
        ),
      );
    }

    const key = `proc/${evaluationId}/inputs/${upload.fileName}`;
    const data = Buffer.from(upload.bytes);

    try {
      await this.client.putObject(this.bucket, key, data, data.length, {
        "Content-Type": upload.contentType,
      });
      return ok({ key });
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", `cannot stage ${key}`, cause));
    }
  }
}
