# redline — Architecture & Dataflow (target state)

> **Status:** ground-truth reference · supersedes the per-thread docs and the
> iteration delivery plans, all deleted. Durable design rationale that is not a
> single decision lives in [`design-principles.md`](./design-principles.md); the
> decisions themselves are in [`adr/`](./adr/).
>
> This is the single source of truth for **what redline is, what it depends on,
> and how data moves through it**. Its companion is
> [`delivery-plan.md`](./delivery-plan.md), the single source of truth for **what
> is left to build** — design lives here, tracking lives there, and neither
> restates the other.
>
> It is written against the *actual* behaviour of
> the upstream engines (womblex is vendored as a submodule at `services/womblex`,
> pinned to `v0.2.0`; Numbatch is a submodule at `services/numbatch`), not against
> aspiration. Where an earlier assumption proved false, the correction is stated
> plainly under **Corrections to earlier assumptions**.

---

## 1. What redline is

redline is a **procurement-evaluation adapter**. A specialist uploads a tender's
response documents, defines the evaluation criteria (requirements) in plain
language, and redline sorts each document against those criteria — surfacing a
review grid, pricing pivots, and an Excel export — with provenance back to the
source text.

redline is **not** a document-extraction engine, a classifier, or an embedding
model. It **composes three upstream systems** over runtime seams and owns only:

- the **domain** (evaluations, requirements, the comprehension lens, responses);
- the **orchestration** (use-cases that drive documents through the pipeline);
- the **control surface** (the review grid, pivots, export, workflow UI);
- its **own** MinIO bucket and Postgres schema (ADR-0002).

Everything heavy — OCR, chunking, embeddings, trained classification, LLM
adjudication — lives behind a seam in an upstream system or an external API.

### The three upstream systems

| System | What it is | How redline consumes it |
|---|---|---|
| **womblex** (`services/womblex`, submodule @ `v0.2.0`) | Python document-extraction pipeline: detect → extract → (redact) → chunk → (embed / enrich / pii). Writes **Parquet shards** to object storage. | As a **worker pod** that lands shards in MinIO, plus a thin **FastAPI read sidecar** (`services/womblex-ingest`) that reads those shards and serves **JSON** (ADR-0003). redline's TypeScript never links a Parquet reader. |
| **Numbatch** (`services/numbatch`, submodule @ `72bcead`) | Python no-code multi-topic classifier: curated samples → LoRA adapter → per-document classification. FastAPI backend + Arq worker + DB-free inference service. Ships a corrections API with an append-only audit trail, topic-scoped sample dedupe, and user-controlled adapter activation with replay comparison. | As a **backend+worker+inference stack** (SvelteKit frontend excluded — redline owns its UI), built from the fork's own Dockerfiles. A redline requirement ↔ a Numbatch topic; a requirement set ↔ a profile. redline **extends** the backend for financial-figure extraction via `services/numbatch-extension/`. |
| **Isaacus** (external SaaS API) | The Kanon model family: `kanon-2-embedder` (retrieval embeddings), `kanon-2-enricher` (entity/graph enrichment + AI chunking), `kanon-universal-classifier`, `kanon-answer-extractor`. | **Only** through womblex's embed/enrich stages. redline never calls Isaacus directly. Requires `ISAACUS_API_KEY`. |

---

## 2. The Isaacus boundary

Womblex's stages split cleanly into offline and Isaacus-gated:

| womblex stage | Needs Isaacus? | Produces |
|---|---|---|
| `detect` / `extract` | **No** — PyMuPDF + PaddleOCR/YOLO, all local | `*.elements`, `*.table_cells`, `*.form_fields`, `*._manifest` parquet |
| `redact` | No — local detector | `*.redactions.parquet` |
| `chunk` (default) | **Yes** (v0.3.0) — `semchunk` sized with the Kanon-2 *tokeniser*, which is API-only (Kanon-2 is not on Hugging Face) | `*.chunks.parquet` |
| `chunk` (AI mode, `chunking.chunking_model` set) | Yes — enricher-driven boundaries | `*.chunks.parquet` (better boundaries) |
| `pii` | No — graph-driven (needs enrich) or a local MiniLM backstop | `*.pii_spans`, `*.clean_text` parquet |
| **`embed`** | **YES** — `kanon-2-embedder` via `client.embeddings.create` | **`*.embeddings.parquet`** |
| `enrich` | **YES** — `kanon-2-enricher` | `*.enrichment_*`, `*.graph_edges`, `*.entity_links` parquet |

**Consequence for redline's retrieval leg (ADR-0008, amended 2026-07-27):** redline's
cold-start classification path *is* nearest-neighbour matching over womblex's
`*.embeddings.parquet`. The embed stage is Isaacus-only. Therefore:

- **Retrieval requires `ISAACUS_API_KEY`.** Without it, `*.embeddings.parquet` is
  never produced, `GET /embeddings/...` is `NOT_FOUND`, and retrieval
  classification cannot run. This is a hard dependency, not a degraded mode.
- **Air-gap / offline operation is a non-goal for redline.** Earlier docs carried
  an "Isaacus-optional / air-gapped" posture (a hangover from womblex's own edge
  modes and Wayfinder's air-gap validation). redline does not pursue it — a
  deployment that cannot reach Isaacus cannot retrieve, which is the whole
  first-pass. Ratified in ADR-0008's 2026-07-27 amendment; the
  `EnrichmentMode.OFFLINE` machinery, the air-gap tests and the Isaacus on/off
  toggle have been removed.
- The only genuinely offline concern is **redline's own infra** (its MinIO/Postgres
  are its own, config-driven, never a hardcoded Wayfinder endpoint — ADR-0002).
  That is unrelated to the Isaacus dependency.
- **Chunking is also Isaacus-gated (v0.3.0).** An earlier revision recorded the
  default chunk stage as offline; a real 0.3.0 run falsifies that — the Kanon-2
  tokeniser is API-only, so `chunk` skips without `ISAACUS_API_KEY`. Chunks *and*
  embeddings therefore both require Isaacus; only `extract`/`table_cells`/`redact`
  are offline. See §7.

---

## 3. Component map

```
┌──────────────────────────── redline (this repo) ────────────────────────────┐
│                                                                              │
│  apps/redline-web        Control surface: workflow, review grid, pricing     │
│    (TypeScript)          pivots, Excel export. No Wayfinder imports in prod. │
│        │                                                                     │
│        ▼                                                                     │
│  packages/redline-application   Use-cases (orchestration): IngestDocuments,  │
│    (TypeScript)                  ClassifyByRetrieval, AdjudicateUnclear,      │
│        │                         BuildEvaluationTable, DocumentMap, pivots.  │
│        ▼                                                                     │
│  packages/redline-domain    Entities + PORTS (Result pattern, zero deps):    │
│    (TypeScript)               IProcurementExtractionReader, IEmbeddingReader, │
│        │                      ITextEmbedder, IProcurementClassifier,          │
│        │                      IFinancialExtractor, IAdjudicator,              │
│        │                      ILanguageModel, IEvaluationRepository.          │
│        ▼                                                                     │
│  packages/redline-adapters   Port implementations — the ONLY code that       │
│    (TypeScript)              speaks to the seams. Each is "as if C" (ADR-0001)│
│        │  ├── womblex/         → HTTP+JSON to womblex-ingest sidecar          │
│        │  ├── embeddings/      → HTTP+JSON to womblex-ingest sidecar          │
│        │  ├── numbatch/        → HTTP to Numbatch backend (classify + finance)│
│        │  └── persistence/     → redline_ Postgres (Drizzle)                 │
│        │                                                                     │
│        └──── seams ────────────────────────────────────────────────────────┤
│                 │ HTTP+JSON            │ HTTP+JSON        │ Postgres          │
│                 ▼                      ▼                  ▼                   │
│  services/womblex-ingest      services/numbatch      redline-postgres        │
│    (FastAPI, Python)            (fork: backend +        (schema: redline_*)   │
│    reads MinIO Parquet,          Arq worker +                                │
│    serves JSON. WOMBLEX_MODE      inference)                                 │
│    = stub | real.                                                            │
│        │ reads                                                               │
│        ▼                                                                     │
│  MinIO  proc/{evaluationId}/*.parquet   ◄── written by ──┐                   │
│  (redline-owned bucket, ADR-0002)                        │                   │
└──────────────────────────────────────────────────────────┼──────────────────┘
                                                            │
                            ┌───────────────────────────────┘
                            │ writes shards
                  services/womblex  (submodule @ v0.2.0)
                    the REAL engine, built from its OWN Dockerfile
                    and run through its OWN cloud runner (Postgres
                    job queue + scalable worker, native S3 staging):
                    extract → chunk → (embed)
                    embed stage calls ──────────────────────► Isaacus API
                                                              (ISAACUS_API_KEY)
```

### Why womblex is split into a pod + a sidecar

- **The engine** (`services/womblex`, the submodule) is heavier than the API
  layer: PyMuPDF, OCR (`engine: paddleocr`, implemented by `rapidocr-onnxruntime`),
  YOLO layout, the Kanon tokeniser, model weights (multi-hundred-MB). It **can**
  run from its own image, built from the submodule's `Dockerfile`, so its
  lifecycle and resource profile *can* be decoupled from the API layer when a
  deployment wants that. It **is not required to be** — co-locating the engine and
  the sidecar on one appropriately-sized host is a valid topology (the sidecar
  image is `python:3.12-slim`, inside womblex's own 3.11/3.12 support, so the
  engine installs alongside it). Its only seam to the rest of the stack is
  **object storage** (ADR-0002) either way — it writes shards, nothing reads back
  into it. redline does not wrap the engine: batching, retry, horizontal scale-out
  and staging are the engine's own (`cloud/worker.py`, `store/remote.py`), driven
  through its `enqueue` / `worker` CLI, and are there to be used *if* the corpus
  justifies scaling out — not a precondition for running at all.
- **The sidecar** (`services/womblex-ingest`) is a lightweight FastAPI app that
  **reads** the engine's Parquet shards from object storage and serves them as
  JSON so redline's TypeScript never links a Parquet reader (ADR-0003).
  `WOMBLEX_MODE` selects `stub` (a deterministic, dependency-free test double for
  fast CI + the adapter contract) or `real` (reads the engine's actual shards).
- **Whether the engine and sidecar are one deployment or two** (a one-shot job, a
  scaled worker fleet, a co-located process) is a **deployment choice, not a code
  choice** — the seam is object storage, and what backs that storage (an S3
  bucket, or an AWS-managed equivalent) is itself config, per ADR-0002. The code
  is architected to make co-location *possible*, not to *require* a shared local
  filesystem.

---

## 4. End-to-end dataflow

```
(1) Upload
    Specialist uploads response documents for an evaluation via redline-web.
    Files land in MinIO (redline bucket).

(2) Extraction + chunking  — the womblex POD
    The womblex pod runs over the evaluation's documents:
        womblex extract  → *.elements / *.table_cells / *.form_fields / *._manifest
        womblex chunk    → *.chunks.parquet          [Isaacus-gated; Kanon-2 tokeniser]
        womblex embed    → *.embeddings.parquet       [ONLY if ISAACUS_API_KEY set]
    NB (v0.3.0): `womblex run` persists only extract shards; `chunk` and `embed`
    are separate per-stage commands (`womblex chunk --shards`, `womblex embed
    --shards`) over the run's shard dir.
    All shards land in MinIO under  proc/{evaluationId}/  (batch-NNNN.<role>.parquet).
    source_hash (SHA-256 of the source bytes) is the document identity throughout.

(3) Read seam  — the womblex-ingest SIDECAR (WOMBLEX_MODE=real)
    POST /ingest  reads the pod's shards, maps womblex's schema → JSON read model,
                  writes {source_hash}.extraction.json + .embeddings.json beside
                  the shards (durable read model surviving a restart).
    GET  /extractions/{eval}/{doc}   → { documentId, elements[], chunks[], tableCells[] }
    GET  /embeddings/{eval}/{doc}    → { documentId, model, dimensions, vectors[] }
    POST /embeddings/query {text}    → { model, dimensions, values[] }   (query vector)
    NB: the embeddings-as-JSON seam is being superseded — at real corpus scale
    (~90k chunks) bulk vectors move to a store (Parquet in MinIO/Postgres),
    queried in place, not shipped to TypeScript. ADR-0017/0018 (Accepted) amend
    ADR-0014; extraction provenance stays JSON. See delivery-plan items 1a/1b.

(4) Ingest use-case  — redline-application
    IngestDocuments confirms every document reads back through the extraction port,
    persists the evaluation, advances the stage.  documents_uploaded → grouping.

(5) Grouping
    Specialist assigns documents → response groups / vendors.

(6) Classification (first pass — no trained model; ADR-0008)
    For each (document, requirement):
      a. HARD RULES resolve deterministically first — rule-claimed docs never
         reach a model  (thread: hard-rule pre-pass).
      b. RETRIEVAL: embed each requirement definition via POST /embeddings/query,
         cosine-match against the document's chunk vectors (GET /embeddings/...).
         REQUIRES the embed stage to have run → REQUIRES Isaacus. The declared
         model on the query vector MUST match the chunk vectors' model or the
         match is refused (vectors from different models are incomparable).
      c. ADJUDICATION: an LLM (IAdjudicator) settles only what retrieval leaves
         ambiguous, emitting a one-sentence rationale.
    Output: RequirementClassification { documentId, requirementId, confidence,
            sourceChunkId } — identical shape whichever path produced it.

(6') Classification (overlay — later; ADR-0008/0009)
    Once boundary decisions accumulate ≥ MIN_SAMPLES_PER_TOPIC per topic, a
    Numbatch LoRA adapter is trained and activated; subsequent runs use it via
    IProcurementClassifier. Same port, same output shape — consumers can't tell.

(7) Financial extraction
    The Numbatch backend extension extracts currency figures per requirement;
    IFinancialExtractor maps topic_id → requirementId, yields estimateAud + provenance.

(8) Review model
    BuildEvaluationTable joins classifications + financials + provenance into
    ProcurementResponse[]. PricingPivot rolls estimateAud per brand/requirement.
    DocumentMap derives the corpus roll-up (per-topic counts, Clear/Ambiguous split).

(9) Output
    redline-web renders the review grid + pivots; Excel export writes a workbook
    with real Number cells for currency and working deep-links to source locations.
```

### The join keys (womblex's real schema — see `services/womblex/docs/extraction.md`)

- **Document identity:** `source_hash` (SHA-256 of source bytes). redline's
  `documentId` == `source_hash`.
- **Element provenance:** `elem_order`, `page`, `text`, `kind`
  (`paragraph`/`heading`/`table`/`form`/`image`/`sheet_cell`/…).
- **Table cells:** children of `kind='table'` elements, joined on
  `(source_hash, parent_elem_order)`. Columns are `row`, `col`, `value`,
  `value_type` — **there is no `is_currency` boolean**; currency is inferred from
  `value_type`.
- **Chunks:** `chunk_index` (0-based per `source_hash`), `text`, `content_type`
  (`narrative` | `table`), `start_char`/`end_char`, nullable `page_start`/`page_end`.
  Chunks join to elements by offset-range overlap, **not** by `elem_order`.
- **Embeddings:** joined to chunks on **`(source_hash, chunk_index, content_type)`**
  in womblex's own store. Columns: `model`, `task`, `dim`, `vector` (float32 list).
  `task` is `retrieval/document` for chunk vectors and **must** be `retrieval/query`
  for query vectors. Note `chunk_index` is a **single monotonic per-document
  sequence spanning narrative *then* table chunks** (womblex re-sequences the
  concatenated list), so `(source_hash, chunk_index)` is already unique across
  content types — the third key never disambiguates a collision (see §7).

redline's JSON wire shape (the sidecar's `records.py` / the domain DTOs) uses
`chunkId = "{source_hash}:{chunk_index}"` and L2-normalises vectors so a
consumer's cosine similarity is a dot product (ADR-0014). `content_type` is
carried as provenance, not as part of the join key (see §7).

---

## 5. Seams & contracts (the invariants that must hold)

1. **Parquet→JSON is one-directional and lives in one place.** Only
   `services/womblex-ingest` understands womblex's Parquet schema. It maps
   `source_hash`/`elem_order`/`chunk_index`/cells/vectors into camelCase JSON
   DTOs. The TypeScript adapters are thin, allocation-only mappings. (ADR-0003)

2. **Object storage is the only seam to the womblex engine.** The engine writes;
   the sidecar reads. Neither imports the other — which is what keeps them
   *separately deployable and freely co-locatable*: the coupling is a storage API
   (S3-shaped), never an in-process link, so the same code runs whether the two
   share a host or not, and what backs the storage (an S3 bucket or an
   AWS-managed equivalent) is config. (ADR-0002)

3. **Embeddings declare their model and cross L2-normalised.** Vectors from
   different models are incomparable; a query vector and the chunk vectors it is
   matched against must declare the same model or the match is refused. (ADR-0014)

4. **Both classification paths satisfy one port.** `RequirementClassification` is
   produced by retrieval+adjudication (cold start) or by the trained Numbatch
   adapter (overlay); consumers cannot tell which ran. (ADR-0008)

5. **Numbatch is used exactly as built.** `MIN_SAMPLES_PER_TOPIC` is never
   relaxed; the fork is additive-only (backend financial extension, no frontend).
   (ADR-0005, ADR-0009)

6. **redline owns its infra.** Its MinIO bucket and Postgres schema are its own,
   config-driven, never a hardcoded Wayfinder endpoint. Wayfinder is consumed
   read-only and materialised from a pin. (ADR-0001, ADR-0002, ADR-0012)

---

## 6. Repository layout

```
redline/
├── apps/redline-web/              control surface (TypeScript)
├── packages/
│   ├── redline-domain/            entities + ports (zero deps, Result pattern)
│   ├── redline-application/       use-cases (orchestration)
│   ├── redline-adapters/          port implementations (the only code at the seams)
│   └── redline-shared/            shared kernel
├── services/
│   ├── womblex/                   ◄ SUBMODULE: the real womblex engine @ v0.2.0
│   ├── womblex-ingest/            FastAPI read sidecar (reads MinIO Parquet → JSON)
│   │   ├── src/womblex_ingest/    stub + real extractor, records (wire shape),
│   │   │                          shard_reader (schema map), storage, embedding
│   │   └── Dockerfile             the light API image
│   ├── numbatch/                  ◄ SUBMODULE: the Numbatch fork @ 72bcead
│   └── numbatch-extension/        redline's additive overlay (financial_extension
│                                  + bootstrap-profile.py), grafts onto the fork
├── infra/
│   ├── docker-compose.yml         profiles: ingest | womblex | numbatch | redline
│   └── womblex/redline.yaml       redline's pipeline config for the engine
├── docs/
│   ├── architecture.md            ◄ THIS FILE — what redline IS (the design truth)
│   ├── delivery-plan.md           what is LEFT TO DO (the tracking truth)
│   ├── adr/                       architecture decision records (still authoritative)
│   ├── design-principles.md       adopted principles + non-goals (durable, not tracking)
│   └── guides/
├── scripts/                       vendor-wayfinder, womblex-pod smoke, etc.
├── vendor/wayfinder/              materialised from wayfinder.pin (never committed)
└── validate.sh                    the CI gate
```

### Vendoring / pinning discipline

- **womblex** — git **submodule** at `services/womblex`, pinned to tag `v0.2.0`
  (`2c40e65`). This is the on-disk source of truth for the Parquet schema the
  sidecar maps, **and the source the engine image is built from** — the `womblex`
  compose profile builds the submodule's own `Dockerfile`. Initialise it with
  `git submodule update --init`; CI checks it out (`submodules: true`). The
  sidecar's `.[womblex]` extra pins the same version for its query embedder;
  `validate.sh` check #13 fails the build if the two drift apart.
- **Numbatch** — git **submodule** at `services/numbatch` (DeepCivic/Numbatch),
  pinned to `72bcead`. Upstream has no tags, so the pin is a SHA rather than a
  tag as womblex's is. The `numbatch` compose profile builds the fork's own
  `infra/docker/*.Dockerfile`s; run all-but-frontend (ADR-0005). redline's
  additive overlay is **not** in the submodule — it lives beside it in
  `services/numbatch-extension/` and grafts onto the fork's `app/` + `alembic/`.
  This supersedes [ADR-0013](./adr/0013-numbatch-fork-is-materialised-from-a-pin.adr.md),
  which chose a build-time pin for consistency with Wayfinder; Wayfinder's pin
  exists because a submodule drags its package set into the pnpm workspace, which
  is a JavaScript problem Numbatch does not have (D14, ADR-0015).
- **Wayfinder** — materialised read-only from `wayfinder.pin` into
  `vendor/wayfinder`, never committed (ADR-0012).

---

## 7. Corrections to earlier assumptions

The per-thread docs and dev-iteration plans carried assumptions that the
vendored womblex source contradicts. Recorded here so they are not re-derived:

1. **Chunking IS Isaacus-gated (v0.3.0) — an earlier "offline chunking"
   assumption is now falsified.** A real 0.3.0 run showed the default `chunk`
   stage skips without `ISAACUS_API_KEY`: it sizes chunks with the **Kanon-2**
   tokeniser, which is API-only (it is not on Hugging Face; the earlier note that
   `semchunk` + a *free* Kanon tokeniser ran offline described a prior engine
   version). A run without Isaacus therefore yields extraction shards **but no
   chunks and no embeddings** — not a usable redline deployment (air-gap is a
   non-goal; see §2). Operationally: `womblex run` persists only extract shards;
   `chunk` and `embed` are separate `--shards` commands.

2. **Retrieval requires Isaacus.** `*.embeddings.parquet` is produced only by
   `kanon-2-embedder` (Isaacus). redline's retrieval classification (ADR-0008)
   therefore requires `ISAACUS_API_KEY`. The "full pipeline runs offline" framing
   from the earlier air-gap work is retired: it was only ever true up to the chunk
   stage, and air-gap is not a redline goal.

3. **The embeddings join is three keys upstream, but the two-key `chunkId` is
   already unique — no collision exists.** womblex joins vectors to chunks on
   `(source_hash, chunk_index, content_type)`. An earlier revision recorded this
   as an **open finding**: that a document with both narrative and table chunks at
   the same `chunk_index` would collide under redline's two-key
   `chunkId = {source_hash}:{chunk_index}`. **A real 0.3.0 run falsifies that.**
   womblex assigns `chunk_index` as a single monotonic per-document sequence
   spanning narrative *then* table chunks (`process/chunker.py` re-sequences the
   concatenated list: `chunk_index = len(repaired)` — e.g. a real REOI is
   narrative 0–21, table 22–29). So `(source_hash, chunk_index)` is **already
   unique across content types**; the third key never disambiguates a real
   collision. `content_type` is kept as **provenance carried alongside a row**,
   not as part of the join key. No `content_type`-aware `chunkId` and no
   seam-identity change are needed. (Resolved.)

4. **Table cells carry no currency flag, and `value_type` cannot supply one.**
   womblex's `TABLE_CELLS_SCHEMA` is `(source_hash, parent_elem_order, row, col,
   value, rowspan, colspan, value_type)` — joined on `parent_elem_order`, with no
   page column. redline's `TableCellRecord.isCurrency` must be **derived**.

   An earlier revision of this section said to infer it from `value_type`. That is
   **falsified**: `value_type` is always `"text"` at `v0.2.0`
   (`ingest/spreadsheet.py:13`, and the only literal ever assigned in the engine's
   source), `number_format` is a column of `ELEMENT_SCHEMA` rather than of
   `table_cells` and is left unset, and womblex has no currency capability
   anywhere in `src/`. Currency is therefore derived from the **verbatim `value`
   string**, and requires an explicit currency marker — a bare number is not
   currency. See [ADR-0016](./adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md),
   which owns the rule and its limits. Both columns are still read first, so a
   future openpyxl-based reader upgrades the signal with no redline change.

   The financial figures redline needs come primarily from the **Numbatch
   financial extension**, not from raw cell typing; the derivation above is what
   the lean vertical (Track V, thread 58) uses to stay off that stack.

5. **There is no `womblex.embed_query` / public embedding helper.**
   `womblex/__init__.py` exports only a docstring and `__version__`. The real query
   embed path is `womblex.analyse.embed.embed_texts([text], isaacus_client, model=…,
   task="retrieval/query")`, with the client from
   `womblex.cli._shared.make_isaacus_client` — it cannot embed offline. The `task`
   matters and is redline's to choose: womblex's own default is
   `retrieval/document`, the *index* side, and a query embedded with it lands in a
   different space from the chunk vectors it is ranked against — degrading silently
   rather than failing. The `model` is read from womblex's own configuration
   (`EmbeddingConfig`, or the deployment's `redline.yaml` via `WOMBLEX_CONFIG`), never
   restated redline-side, so chunks and queries cannot drift onto different models.
   Built in thread 56.

6. **The womblex/Numbatch overlap is not real — closed, no change.** This section
   previously said womblex *exposes* `kanon-universal-classifier` (zero-shot
   classification) and `kanon-answer-extractor` (structured field extraction), and
   asked whether they could retire redline's Numbatch financial extension.

   Reading the engine settles it: **neither model appears anywhere in womblex's
   source.** They are named only in its `README.md` (lines 237–238), in a passage
   describing what the *Isaacus platform* offers. womblex does not wire them, so
   consuming them would mean redline calling Isaacus directly — which §1 forbids.
   Numbatch has no currency capability of its own either. redline's classification
   and financial extraction therefore stay where ADR-0004/0005/0008 put them, and
   the Numbatch financial extension is genuinely additive, exactly as ADR-0005
   intended.

---

## 8. Runtime & environment notes

- womblex requires **Python 3.11/3.12** (its OCR dep `rapidocr-onnxruntime` has no
  wheel on 3.10 or 3.13). The **sidecar image is `python:3.12-slim`** — inside that
  window — so nothing stops `pip install .[womblex]` co-locating the engine with
  the sidecar. The engine **can** run from its own image for resource/lifecycle
  isolation (heavy OCR/YOLO/tokeniser/model runtime, its own cloud runner for
  scale-out), and **can** equally run co-located with the sidecar on one
  appropriately-sized host — the split is a deployment choice, not a code
  constraint. The one interpreter caveat that remains is that a developer's
  `validate.sh` box may run a *newer* interpreter (e.g. 3.13) that womblex's OCR
  wheel does not cover, which is why the engine-touching tests `importorskip` the
  `[womblex]` extra rather than assuming it is present.
- The womblex-ingest sidecar's **real binding** decodes Parquet with `pyarrow`
  (light) — that half runs anywhere pyarrow resolves, independent of whether the
  engine is installed in the same environment. Producing the shards (and any query
  embedding) requires the engine and, for embeddings, Isaacus.
- `ISAACUS_API_KEY` is the single switch that turns retrieval on. Without it:
  extraction shards land, but there are **no chunks and no embeddings** (both the
  `chunk` and `embed` stages are Isaacus-gated in v0.3.0), and no retrieval
  classification. redline treats that as a misconfiguration, not a supported mode
  (§2; ADR-0008, amended 2026-07-27).

---

## 9. Where to look next

- **womblex's real schema & stages:** `services/womblex/docs/extraction.md`,
  `services/womblex/docs/dataflow.md`, `services/womblex/docs/architecture.md`
  (the submodule's own docs — authoritative for the engine).
- **The wire shape redline serves:** `services/womblex-ingest/src/womblex_ingest/`
  (`records.py` = DTOs, `shard_reader.py` = the schema map, `real_extractor.py`).
- **Decisions:** `docs/adr/` (authoritative).
- **Outstanding work:** [`delivery-plan.md`](./delivery-plan.md) — the only
  document that tracks what is left to build.
- **Design rationale (durable, non-tracking):** [`design-principles.md`](./design-principles.md)
  — the composable-operations principles redline adopted from its upstreams and
  the non-goals it holds.