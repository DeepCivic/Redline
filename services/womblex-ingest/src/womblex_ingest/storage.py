"""Object-storage seam (MinIO/S3).

Kept deliberately thin: `put_object` / `get_object`. `S3ObjectStorage` wraps boto3
and is only constructed at process start (see `main.build_app` callers), so tests use
`FakeObjectStorage` and never touch boto3 or a live bucket. `get_object` backs the
Parquet→JSON read seam: the JSON read model is durably stored alongside the Parquet
shards, so `GET /extractions/...` survives a sidecar restart (MinIO is the record).
"""

from __future__ import annotations

from typing import Protocol


class ObjectNotFound(Exception):
    """Raised by `get_object` when the key is absent."""


class ObjectStorage(Protocol):
    def put_object(self, key: str, body: bytes, content_type: str) -> None: ...

    def get_object(self, key: str) -> bytes:
        """Return the object body, or raise `ObjectNotFound` if the key is absent."""
        ...


class S3ObjectStorage:
    """boto3-backed writer against a MinIO/S3 endpoint.

    The bucket is created on first use if missing so a fresh MinIO comes up ready
    for the Thread 3 smoke test without a manual `mc mb` step.
    """

    def __init__(
        self,
        *,
        endpoint_url: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        region: str = "us-east-1",
    ) -> None:
        import boto3
        from botocore.client import Config

        self._bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(signature_version="s3v4"),
        )
        self._ensure_bucket()

    def _ensure_bucket(self) -> None:
        from botocore.exceptions import ClientError

        try:
            self._client.head_bucket(Bucket=self._bucket)
            return
        except ClientError:
            pass
        self._client.create_bucket(Bucket=self._bucket)

    def put_object(self, key: str, body: bytes, content_type: str) -> None:
        self._client.put_object(
            Bucket=self._bucket, Key=key, Body=body, ContentType=content_type
        )

    def get_object(self, key: str) -> bytes:
        from botocore.exceptions import ClientError

        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404", "NotFound"):
                raise ObjectNotFound(key) from error
            raise
        return response["Body"].read()
