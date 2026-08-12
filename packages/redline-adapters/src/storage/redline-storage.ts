// The production wiring for the staged-corpus write seam: a real minio Client
// pointed at redline's own bucket. Kept beside the adapter and separate from it
// so the adapter stays client-injected (and testable without a live bucket)
// while the one place that imports `minio` is here.
//
// The seam is plain S3 (ADR-0002): path-style for MinIO, repointed at AWS by
// config. Reads its endpoint/credentials/bucket from the same S3_* / REDLINE_*
// values the sidecar and the compose profiles already use, so redline never
// restates its bucket coordinates.

import { Client } from "minio";
import { MinioStagedCorpusWriter } from "./minio-staged-corpus-writer";

export interface RedlineStorageOptions {
  // Endpoint host without scheme (minio's client takes host + port + useSSL
  // separately), e.g. "minio" in compose or "s3.ap-southeast-2.amazonaws.com".
  readonly endpoint: string;
  readonly port: number;
  readonly useSSL: boolean;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  // Empty for MinIO/self-signed; set for AWS so the client signs for the right
  // region rather than guessing.
  readonly region?: string;
}

export const createStagedCorpusWriter = (
  options: RedlineStorageOptions,
): MinioStagedCorpusWriter => {
  const client = new Client({
    endPoint: options.endpoint,
    port: options.port,
    useSSL: options.useSSL,
    accessKey: options.accessKey,
    secretKey: options.secretKey,
    pathStyle: true,
    ...(options.region && options.region.length > 0 ? { region: options.region } : {}),
  });

  return new MinioStagedCorpusWriter({ client, bucket: options.bucket });
};
