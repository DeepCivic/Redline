# Thread 4 — Extraction reader adapter (Parquet→JSON boundary)

**Status:** ✅ Complete · **Date:** 2026-07-25 · **Version intent:** MINOR (new adapter surface + sidecar read endpoint + ADR-0003; no breaking changes, pre-1.0)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 1](../procurement-evaluation-plan.md)
· ADRs: [ADR-0001](../adr/0001-adapter-over-wayfinder.adr.md), [ADR-0002](../adr/0002-own-minio-and-postgres.adr.md), [ADR-0003](../adr/0003-parquet-to-json-boundary.adr.md)

## Goal

Decide the womblex extraction boundary and implement `IProcurementExtractionReader`
(elements / chunks / table-cells + provenance) in `packages/redline-adapters`.

**Exit test:** the adapter reads a real run into typed objects; a contract test runs
against a fixture. **→ PASSED** (evidence below).

## Cross-cutting decision locked

Build plan §8 **decision #2** (Parquet boundary) was *decide in Thread 4*. Locked in
**[ADR-0003](../adr/0003-parquet-to-json-boundary.adr.md)**: the boundary is **JSON**.
The `womblex-ingest` sidecar — which already owns the heavy womblex/Parquet stack —
reads its own shards and serves a typed JSON read model. The TypeScript workspace
takes **no Parquet dependency**; the adapter's only coupling to the sidecar is HTTP +
JSON, honouring ADR-0001's "design as if C".

## The boundary

```
womblex → Parquet shards (MinIO, proc/{eval}/*.parquet)   ← durable record
                     │  read + normalise (records.py) — the one schema-aware place
                     ▼
   JSON read model:  proc/{eval}/{documentId}.extraction.json
                     │  GET /extractions/{eval}/{documentId}
                     ▼
   WomblexExtractionReader (TS)  →  ExtractionElement / ExtractionChunk / ExtractionTableCell
```

The JSON field names match `IProcurementExtractionReader`'s DTOs exactly (camelCase),
so the reader is an allocation-only mapping. womblex's `source_hash` / `elem_order` /
`chunk_id` / currency-cell vocabulary is normalised in exactly one module.

## What was built

### Sidecar (Python) — server side of the boundary

| File | Change |
|---|---|
| `src/womblex_ingest/records.py` | **New.** Canonical wire dataclasses: `ElementRecord`, `ChunkRecord`, `TableCellRecord`, `DocumentExtraction` (+ `to_json`). CamelCase to mirror the domain DTOs. |
| `src/womblex_ingest/extraction.py` | `ExtractionResult` gains a `documents` read model; `StubWomblexExtractor` now emits it (deterministic `source_hash` documentId, `chunkId = {hash}:0`, a currency cell). |
| `src/womblex_ingest/storage.py` | `ObjectStorage` protocol gains `get_object`; `S3ObjectStorage.get_object` maps a missing key to `ObjectNotFound`. |
| `src/womblex_ingest/main.py` | `POST /ingest` writes each document's JSON beside the shards; **new** `GET /extractions/{evaluationId}/{documentId}` (404 `NOT_FOUND` when absent). |
| `src/womblex_ingest/real_extractor.py` | Docstring pins the Parquet→JSON mapping the real path must honour; still fails loudly. |
| `tests/conftest.py`, `tests/test_ingest_api.py`, `tests/test_stub_extractor.py` | Fake storage grew `get_object`; new tests for the JSON write + read seam + stub read model (12 → 17). |

### Adapter (TypeScript) — `packages/redline-adapters`

| File | Role |
|---|---|
| `src/womblex/womblex-extraction-reader.ts` | `WomblexExtractionReader implements IProcurementExtractionReader` over an injected `HttpClient` (a `fetch`-shaped seam). One document-scoped fetch backs all three methods. |
| `src/womblex/wire.ts` | Wire interfaces + `parseDocumentExtraction` (narrows untrusted JSON → typed, or `EXTRACTION_FAILED`) + `parseErrorBody` (maps the sidecar's Result-shaped errors). |
| `src/womblex/__fixtures__/extraction-tender.pdf.json` | A **real capture** of a `GET /extractions/...` response. |
| `src/womblex/__fixtures__/README.md` | How to regenerate the fixture from the sidecar. |
| `src/womblex/womblex-extraction-reader.test.ts` | 8 contract tests: happy path per method, URL-encoding, and the full error taxonomy. |
| `src/index.ts` | Exports the reader (replaced the placeholder). |

## Design decisions

1. **JSON boundary, server-side Parquet.** The sidecar reads Parquet and serves JSON,
   so the TS surface stays Parquet-free and womblex-schema knowledge is confined to
   one Python module. (ADR-0003.)
2. **JSON materialised beside the shards** (`{documentId}.extraction.json`). The read
   seam is durable across a sidecar restart — the in-memory run registry is not the
   record; MinIO is (ADR-0002) — for the price of a small extra object per document.
3. **Injected `HttpClient` seam.** The reader depends only on a `fetch`-shaped function
   and `@redline/redline-domain` — no global `fetch`, no Parquet/S3 client, no Node
   built-ins. It is unit-testable against a fixture with zero external dependencies.
4. **Error taxonomy at the seam.** `NOT_FOUND` passes through; other read-seam failures
   → `EXTRACTION_FAILED`; transport failures → `INFRA_FAILURE`; a non-JSON or malformed
   body → `EXTRACTION_FAILED`. Nothing throws across the port edge (Result pattern).
5. **Fixture is a real capture, not hand-written**, so the JSON contract is pinned on
   both sides — a sidecar schema drift would break the contract test.

## Exit-test evidence

**Contract test** (`WomblexExtractionReader` over the captured fixture), Node 20 via
Podman:

```
✓ reads elements from a real run into typed provenance
✓ reads chunks with womblex chunkId provenance ({source_hash}:{index})
✓ reads currency-typed table cells
✓ requests the document-scoped read-seam URL, URL-encoding the ids
✓ maps the sidecar's NOT_FOUND body to a NOT_FOUND DomainError
✓ maps a transport failure to INFRA_FAILURE without throwing
✓ maps a malformed payload to EXTRACTION_FAILED
✓ maps a non-JSON body to EXTRACTION_FAILED          → 8/8
```

- `pnpm --filter=@redline/redline-adapters typecheck` → clean; `lint` → clean.
- Sidecar `pytest -q` → **17 passed** (was 12; +5 for the JSON read seam).
- `./validate.sh` → **Passed: 10, Failed: 0** (workspace tests 7/7 incl. adapters;
  check #10 sidecar pytest).

## Known limitations / follow-ups

1. **Real womblex still not wired.** `WOMBLEX_MODE=real` raises `NotImplementedError`;
   `records.py` now pins the Parquet→JSON mapping the real path must produce, but the
   concrete womblex call surface + shard-reading code are still pending.
2. **Whole-document payloads.** `GET /extractions/...` serves one document's full read
   model in a single response. Fine for the review flow's document sizes; pagination
   or streaming can be layered on the same seam later without a domain change.
3. **`page`/`bbox` fidelity.** The wire carries `page` (nullable); richer `bbox`
   provenance is deferred until a UI thread (12) needs it.

## How to reproduce

```bash
# adapter contract test (Node 20 via Podman when no local node)
cd redline
PODMAN="flatpak-spawn --host podman" bash scripts/podman-run.sh \
  "pnpm install >/dev/null 2>&1 && pnpm --filter=@redline/redline-adapters test"

# sidecar suite (isolated venv)
cd services/womblex-ingest && python3 -m venv .venv && . .venv/bin/activate \
  && pip install -e '.[dev]' && python -m pytest -q

# full gate
./validate.sh

# regenerate the fixture: see packages/redline-adapters/src/womblex/__fixtures__/README.md
```
