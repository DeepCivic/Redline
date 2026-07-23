"""womblex-ingest — womblex document-extraction sidecar for redline.

HTTP wrapper around womblex: `POST /ingest` runs extraction for an evaluation's
documents and writes Parquet shards to object storage under `proc/{evaluationId}/`;
`GET /status/{run_id}` reports run state. See docs/threads/thread-03-*.md.
"""
