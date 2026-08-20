# run-throsby-demo — real womblex run shards

A **real** `womblex run` output, copied verbatim from the womblex UI demo's
sample corpus (`output/console-demo/run-throsby-demo/` in the `womblex` repo).

This is what redline's read seam is designed and tested against: the actual
Parquet shapes, not invented column names. `tests/test_shards.py` reads these
shards directly, so a mapping written against a column womblex does not write
fails here rather than three layers downstream as an empty result. The schemas
are documented in [`docs/Womblex-Output-Contract.md`](../../../../../docs/Womblex-Output-Contract.md).

One document: `throsby-oosc.pdf` — byte-identical (sha256
`c5c98a36…cef54`, the `source_hash` every shard keys on) to the ACT FOI 213A
notice womblex vendors redistributably at
`fixtures/fixtures/womblex-collection/_documents/00768-213A-…_Redacted.pdf`,
renamed for the demo. A published FOI release; the ACT government's own
redactions are intact in the source, so the extracted text carries no
identity the publisher withheld.

Which womblex stages produced these shards is womblex's business, not
redline's — the shard set below is the contract. What matters here is that no
PII stage ran, so there is no `clean_text` / `pii_spans` sidecar and chunk
text is unmasked: it names the signing public servant and her published work
email, as the source document does.

## Layout

Row counts are as-measured, not aspirational — the empty ones are the point
of the "Coverage" section below.

```
manifest.parquet                            1    MANIFEST_SCHEMA
documents/batch-0001._manifest.parquet      1    per-batch manifest sidecar
documents/batch-0001.elements.parquet      24    element stream
documents/batch-0001.table_cells.parquet    0    EMPTY
documents/batch-0001.form_fields.parquet    2
documents/batch-0001.chunks.parquet         4    CHUNKS_SCHEMA
documents/batch-0001.chunk_quality.parquet  4
documents/batch-0001.enrichment_doc.parquet 1    persisted Kanon-2 Document
documents/batch-0001.enrichment_entities.parquet 34  ENTITY_SCHEMA
documents/batch-0001.enrichment_meta.parquet 1
documents/batch-0001.graph_edges.parquet   156   GRAPH_EDGE_SCHEMA
documents/batch-0001.money_spans.parquet    2    MONEY_SPANS_SCHEMA
documents/batch-0001.money_columns.parquet  0    EMPTY
documents/batch-0001.embeddings.parquet     4    EMBEDDINGS_SCHEMA
```

No checkpoint directories (`.chunk-checkpoint/` etc.) are carried across —
those are pipeline resume state, not part of the corpus schema.

## Coverage — what this corpus cannot prove

One small, narrative, text-layer PDF. It is enough to check the read seam
against real column names and real values. It is not enough to *prove* the
following, and a step that needs them needs a second corpus, not a fake row
appended here:

- **`table_cells` is empty** (`table_cells_count: 0` in the manifest agrees).
  The table-cell read has no real row to answer with, and neither has any
  table-cell money locus. The shard is present and schema-correct, so the
  "empty, not missing" case is covered; the populated case is not.
- **`money_columns` is empty and `money_spans` has two rows**, both `narrative`
  locus (`$10 000` / `$50 000` AUD statutory penalties). The `table_cell` and
  `sheet_cell` loci and column classification are entirely unexercised.
- **One document, one run.** A corpus run twice must serve every document once;
  a single-run corpus cannot regress that. `test_shards.py` stages two runs by
  copying this one, which proves the run-scoping mechanism but not a genuine
  second extraction.

## Identity columns differ by shard family

`chunks`, `elements`, `money_*`, `embeddings`, `table_cells`, `form_fields`
and `chunk_quality` key on **`source_hash`**. The three enrichment/graph
shards — `enrichment_entities`, `enrichment_meta`, `graph_edges` — key on
**`document_id`**. Measured here, the two carry the *same value*, so this is a
spelling difference and not an identity split. Any port or route that joins a
graph shard to a chunk shard has to know both spellings; `shard_reader.py`
already reads `elem_order` / `parent_elem_order` defensively for the same
reason.

## Regenerating

From the `womblex` repo (not this one), the source run lives at
`output/console-demo/run-throsby-demo/`. Re-copy `manifest.parquet` and every
`documents/batch-*.parquet` (excluding the `.*-checkpoint/` directories) here
after any upstream schema change, so this fixture never drifts silently ahead
of the schema the read seam is designed against. Update
`docs/Womblex-Output-Contract.md` in the same commit.
