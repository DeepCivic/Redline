# run-throsby-demo — real womblex run shards (build step 0c)

A **real** `womblex run` output, copied verbatim from the womblex UI demo's
sample corpus (`services/womblex` @ `d50ac76`, "Demo corpus: complete the
Throsby run to the DEFAULT-Isaacus shape", `output/console-demo/run-throsby-demo/`).
This is the corpus build step 0c (`docs/Redline-Plan.md` §9) hands to step 1's
schema-design pass — the actual Parquet shapes the seven corpus-read ports are
designed against, not invented column names.

One document: `throsby-oosc.pdf`, the single ACT FOI 213A notice vendored
redistributably in womblex's own fixture set
(`fixtures/fixtures/womblex-collection/_documents/`, see womblex's
`THIRD_PARTY_DATA.md`) — safe to carry its derived shards here.

Drained through the **DEFAULT-Isaacus** pipeline shape: extract → enrich (AI
chunking against the persisted Kanon-2 Document) → graph-refresh → chunk
quality → money → embed. PII/spellfix are excluded from this shape, so there
is no `clean_text` / `pii_spans` sidecar here.

## Layout

```
manifest.parquet                          # MANIFEST_SCHEMA — one row, throsby-oosc.pdf
documents/batch-0001._manifest.parquet    # per-batch manifest sidecar
documents/batch-0001.elements.parquet     # element stream (paragraphs, headings, tables, forms)
documents/batch-0001.table_cells.parquet  # table cell sidecar
documents/batch-0001.form_fields.parquet  # form field sidecar
documents/batch-0001.chunks.parquet       # CHUNKS_SCHEMA
documents/batch-0001.chunk_quality.parquet
documents/batch-0001.enrichment_doc.parquet     # persisted Kanon-2 Document (AI-chunking reuse)
documents/batch-0001.enrichment_entities.parquet # ENTITY_SCHEMA
documents/batch-0001.enrichment_meta.parquet
documents/batch-0001.graph_edges.parquet         # GRAPH_EDGE_SCHEMA
documents/batch-0001.money_spans.parquet         # MONEY_SPANS_SCHEMA
documents/batch-0001.money_columns.parquet
documents/batch-0001.embeddings.parquet          # EMBEDDINGS_SCHEMA
```

No checkpoint directories (`.chunk-checkpoint/` etc.) are carried across —
those are pipeline resume state, not part of the corpus schema.

## Regenerating

From the `womblex` repo (not this one), the source run lives at
`output/console-demo/run-throsby-demo/`. Re-copy `manifest.parquet` and every
`documents/batch-*.parquet` (excluding the `.*-checkpoint/` directories) here
after any upstream schema change, so this fixture never drifts silently ahead
of the schema the port contracts are designed against.
