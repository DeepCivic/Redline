# Womblex output contract

> The stable, documented foundation Redline reads. **Womblex is locked**: its
> shard layout and column names are an upstream contract, recorded here so this
> repo needs neither a submodule nor a Womblex install to know what it is reading
> against.

Recorded from `womblex` **v0.4.0** (`DeepCivic/womblex`, `src/womblex/store/`).
Redline consumes these assets read-only and never writes them.

## Why this file exists

Womblex was previously consumed as a git submodule so a session could read
`store/output.py` for the real column names. That coupling is gone. The column
names are the contract, so the contract is written down instead — one file to
re-check against an upstream release, rather than a pinned tree to keep
initialised in every clone.

The failure this guards against is on record: an earlier mapping invented
`elem_order` / `col_index` / `is_currency` on table cells and raised on every
real row. Table cells key on `parent_elem_order`, carry no page and carry no
currency column at all. Read from this file, not from memory.

## Run layout

A run writes under `<output_root>/<run_id>/`, and Redline's object storage
mirrors that as:

```
proc/{corpusId}/runs/{runId}/documents/batch-NNNN.<shard>.parquet
proc/{corpusId}/runs/{runId}/manifest.parquet
```

`run_id` is `run-YYYYMMDDTHHMMSSZ` — sortable, so the lexicographically greatest
id is the most recent (`store/retention.py:most_recent_run` sorts the same way).
Directories not prefixed `run-` are a pre-run-id layout and are read as a single
implicit run.

**Every read must be run-scoped.** Multiple runs co-exist under one corpus
prefix by design (retention keeps the current run plus previous). Concatenating
across them serves each document once per run, and `elementOrder` then identifies
nothing.

`manifest.parquet` at the run root is the consolidation of every per-batch
`._manifest.parquet` beneath it; both carry `MANIFEST_SCHEMA`.

## Document identity

Two spellings, same value:

| Shard family | Identity column |
| --- | --- |
| `elements`, `table_cells`, `form_fields`, `manifest`, `chunks`, `chunk_quality`, `embeddings`, `money_spans`, `money_columns`, `enrichment_doc` | `source_hash` |
| `enrichment_entities`, `enrichment_meta`, `graph_edges` | `document_id` |

`source_hash` is the sha256 of the source document. Any route or port joining a
graph shard to a chunk shard must accept both spellings.

Chunk identity across Redline is `{source_hash}:{chunk_index}`, recomposed from
the two columns rather than trusting a producer-supplied `chunk_id` — the
extraction and embeddings shards then join on one identity instead of two
independently-produced strings agreeing.

## Shard schemas

Column names and Arrow types are verbatim from Womblex. Suffixes are the file
name suffix under `documents/`.

### `.elements.parquet` — `ELEMENT_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `collection_id` | string |
| `elem_order` | int32 |
| `kind` | string |
| `extractor` | string |
| `confidence` | float32 |
| `page` | int32 |
| `bbox` | struct(`x`, `y`, `width`, `height`: float32) |
| `text` | string |
| `alt_text` | string |
| `header_rows` | list(int32) |
| `sheet` | string |
| `row` | int32 |
| `col` | int32 |
| `value` | string |
| `value_type` | string |
| `formula` | string |
| `number_format` | string |
| `merge_range` | string |
| `meta` | map(string, string) |

`text` is nullable and legitimately absent, not a fault: only text-bearing kinds
populate it. `table`, `image`, `figure`, `form`, `page_break`, `sheet_meta` and
`sheet_cell` all serialise `text: None`. Fall back to `alt_text`, then to `""` —
never drop the element, because dropping one breaks `elem_order` contiguity and
loses the document's tables along with all of its pricing.

### `.table_cells.parquet` — `TABLE_CELLS_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `parent_elem_order` | int32 |
| `row` | int32 |
| `col` | int32 |
| `value` | string |
| `rowspan` | int32 |
| `colspan` | int32 |
| `value_type` | string |

Note what is **absent**: no `page`, and no currency column. `value_type` is
`"text"` on every row at the versions measured, and `number_format` is unset, so
any currency signal Redline reports is derived from the cell text and must be
labelled as derived. A `sheet_cell` *element* carries the same payload under
`elem_order` / `row` / `col` / `value` and does have a page.

### `.form_fields.parquet` — `FORM_FIELDS_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `parent_elem_order` | int32 |
| `field_index` | int32 |
| `name` | string |
| `value` | string |
| `field_type` | string |

### `._manifest.parquet` / `manifest.parquet` — `MANIFEST_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `collection_id` | string |
| `doc_id` | string |
| `filename` | string |
| `ext` | string |
| `extraction_method` | string |
| `elements_count` | int64 |
| `table_cells_count` | int64 |
| `form_fields_count` | int64 |
| `status` | string |
| `error` | string |
| `extracted_at_iso` | string |
| `parser_version` | string |

This is the document list for a run — the only shard that maps a `source_hash`
back to a human-readable `filename`.

### `.chunks.parquet` — `CHUNKS_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `chunk_index` | int32 |
| `text` | string |
| `start_char` | int32 |
| `end_char` | int32 |
| `content_type` | string |
| `has_redaction` | bool |
| `page_start` | int32 |
| `page_end` | int32 |
| `elem_order` | int32 |

`elem_order` was added after parser 2.0; shards written before it are back-filled
with nulls on read rather than failing.

The two content types address differently and the difference matters: a
`narrative` chunk carries `start_char`/`end_char` (offsets into the reassembled
narrative — the coordinate space a money span's narrative locus reads) and a null
`elem_order`; a table chunk carries `elem_order` (the table element it was cut
from, null for a spreadsheet-sheet chunk, which has no single anchor element) and
null offsets, because its offsets would be into table markdown.

### `.chunk_quality.parquet` — `CHUNK_QUALITY_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `chunk_index` | int32 |
| `content_type` | string |
| `char_len` | int32 |
| `alpha_frac` | float64 |
| `is_short` | bool |
| `boilerplate_flag` | bool |
| `exact_dup_id` | int32, nullable — null means singleton |
| `near_dup_id` | int32, nullable — null means singleton |

### `.embeddings.parquet` — `EMBEDDINGS_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `chunk_index` | int32 |
| `content_type` | string |
| `model` | string |
| `task` | string |
| `dim` | int32 |
| `vector` | list(float32) |

Joins to `.chunks.parquet` on `(source_hash, chunk_index, content_type)`.
**Womblex ships no index** — the vectors sit on disk and nothing ranks them, so
there is no similarity search to expose without building one.

### `.enrichment_entities.parquet` — `ENTITY_SCHEMA`

| Column | Type |
| --- | --- |
| `document_id` | string |
| `entity_id` | string |
| `entity_label` | string — `person`, `location`, `term`, `external_document` |
| `name` | string |
| `entity_type` | string — `natural`, `corporate`, `politic`, `country`, `state`, … |
| `role` | string — persons only |
| `mention_start` | int32 |
| `mention_end` | int32 |
| `chunk_index` | int32 — **-1 when the mention maps to no chunk** |

### `.graph_edges.parquet` — `GRAPH_EDGE_SCHEMA`

| Column | Type |
| --- | --- |
| `document_id` | string |
| `source_id` | string |
| `target_id` | string |
| `relation` | string |
| `prop_key` | string |
| `prop_value` | string |

`source_id`/`target_id` are `entity_id` values from `ENTITY_SCHEMA`. An edge
locates a chunk (via the entity's `chunk_index`); it is not itself source text.

### `.enrichment_meta.parquet` — `ENRICHMENT_META_SCHEMA`

| Column | Type |
| --- | --- |
| `document_id` | string |
| `doc_type_enriched` | string — `statute`, `regulation`, `decision`, `contract`, `other` |
| `jurisdiction` | string |
| `title` | string |
| `segment_count`, `person_count`, `location_count`, `term_count`, `external_doc_count`, `date_count`, `heading_count`, `junk_span_count` | int32 |

### `.enrichment_doc.parquet` — `ENRICHMENT_DOC_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `text_source` | string — `elements`, `normalised`, `spellfix` |
| `document_json` | string — a serialised Document |

### `.money_spans.parquet` — `MONEY_SPANS_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `locus` | string — `narrative`, `table_cell`, `sheet_cell` |
| `text_source` | string — narrative only |
| `start_char`, `end_char` | int32 — narrative anchor |
| `page` | int32 |
| `elem_order` | int32 — sheet_cell anchor |
| `parent_elem_order` | int32 — table_cell anchor |
| `sheet` | string |
| `row`, `col` | int32 |
| `text` | string — the original, never lost |
| `value` | decimal128(38, 4) |
| `currency` | string, nullable — money-marked, currency unresolved |
| `currency_source` | string — `symbol`, `iso`, `word`, `number_format`, `column_header`, `document_default` |
| `evidence` | string — `p1`…`p11`, `number_format`, `header+numeric`, `header_currency` |
| `modifier` | string — `approximately`, `up to`, … |
| `multiplier` | string — `thousand`, `million`, `billion`, `trillion`, `cents` |
| `negative` | bool |
| `confidence` | float32 |
| `range_group` | int32, nullable — links a range's endpoints |
| `range_role` | string — `lower`, `upper` |
| `column_id` | string, nullable |
| `context` | string |

**`value` already carries its sign and its magnitude.** `multiplier` and
`negative` are an audit trail of how the amount was read, not arithmetic to redo.
Multiplying `value` by its `multiplier`, or re-applying `negative`, double-counts.

`modifier` is deliberately **not** folded in, so a bounded amount ("up to
$50 000") is not an exact one. `range_group`/`range_role` link two rows that are
one amount's two endpoints.

### `.money_columns.parquet` — `MONEY_COLUMNS_SCHEMA`

| Column | Type |
| --- | --- |
| `source_hash` | string |
| `column_id` | string |
| `locus` | string — `table_cell`, `sheet_cell` |
| `parent_elem_order` | int32 |
| `sheet` | string |
| `col` | int32 |
| `header_text` | string |
| `number_format` | string |
| `verdict` | string — `money`, `vetoed`, `insufficient` |
| `evidence` | string |
| `veto_term` | string |
| `currency` | string |
| `scale` | string |
| `numeric_fraction`, `null_fraction`, `confidence` | float32 |
| `cells_total`, `cells_extracted` | int32 |

### Shards Redline does not read

`.entity_links.parquet`, `.normalised_text.parquet`, `.spellfix_text.parquet`,
`.spellfix_corrections.parquet`, `.pii_spans.parquet`, `.clean_text.parquet`,
`.provenance.parquet`. Listed so an unexpected file is recognised rather than
mistaken for corruption.

Note that `pii_spans` / `clean_text` are absent unless a PII stage ran. Where it
did not, chunk text is unmasked and carries whatever the source document carried.

## Verifying this file against an upstream release

This contract is only as good as its last check. To re-verify, read
`src/womblex/store/*.py` in `DeepCivic/womblex` at the release in question and
compare each `pa.schema([...])` block against the tables above. A column added
upstream is additive and safe to ignore until something needs it; a column
**renamed or removed** breaks a Redline read, and is a change to land here and in
the read seam together.

The fixture at `services/womblex-ingest/tests/fixtures/run-throsby-demo/` is a
real run's shards and is the other half of this check — it holds real rows for
every schema above except `table_cells` and `money_columns`, which are empty in
that corpus.
