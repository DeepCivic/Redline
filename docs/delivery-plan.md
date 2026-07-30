# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-07-30
>
> **This tracks outstanding work only. It does not restate design.**
> [`architecture.md`](./architecture.md) is the single source of truth for *what
> redline is and how data moves through it*; [`adr/`](./adr/) holds the decisions;
> [`design-principles.md`](./design-principles.md) holds the durable adopted
> principles and non-goals. This file holds *what is left to do* and nothing else.
> Completed work and the reasoning behind superseded plans live in git history.
>
> Item numbers here are local to this document and are renumbered whenever the
> outstanding set changes; they carry no history and never need to line up with
> anything in the code or the ADRs.

---

## 1. The build-step contract

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two steps.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.

---

## 2. The lean vertical (current priority)

**Goal: a real procurement corpus goes in, and the results come out on screen,
delineated by topic and brand.** Nothing else. The comprehension-lens work and
the trained-classifier overlay are **deferred** (§3) — they are a second-order
improvement on a product that does not yet render.

**Numbatch is not on this path.** Classification runs cold-start over womblex
embeddings ([ADR-0008](./adr/0008-trained-classifier-is-an-optional-overlay.adr.md)'s
first pass — no samples, no training, no adapter), and pricing comes from
womblex's own currency-typed table cells / money sidecars. The Numbatch stack
re-enters only when a *trained* overlay or the financial extension's roll-up is
wanted; neither is needed to see the grid.

Most of this slice already exists (use-cases, adapters, web core, the compose
profiles — all green under `./validate.sh`). The retrieval leg is the exception:
ADR-0017/0018 (Proposed) rebuild it on a store, superseding the current
in-TypeScript vector path. What remains, in order:

### 1a — Materialise womblex embeddings into the retrieval store

**New, and it precedes retrieval.** [ADR-0017](./adr/0017-bulk-womblex-data-stays-parquet-json-is-for-presentation.adr.md)
/ [ADR-0018](./adr/0018-retrieval-is-a-store-side-query-surface.adr.md) (both
**Proposed** — ratify before building) overturn ADR-0014: at the measured corpus
scale (~1,500 docs → ~90k chunks × 1792-d ≈ 645 MB packed / ~2.5–3 GB as JSON),
vectors do **not** cross to TypeScript. The sidecar loads `*.chunks.parquet` +
`*.embeddings.parquet` into redline's `redline_` Postgres schema (`pgvector`), a
queryable projection with MinIO shards remaining the durable record (ADR-0002).

_Exit: an ingest of a real corpus lands chunk rows + vectors in `redline_`
(pgvector index built); an absent embed stage leaves the extraction queryable and
the vector tables empty (NOT_FOUND on similarity, not a broken ingest)._

### 1b — Retrieval-backed `IProcurementClassifier` over the store

`ClassifyResponseGroup` takes an `IProcurementClassifier`; the container wires
whichever implementation a deployment supplies. Today the only one is Numbatch's,
which needs 10 samples/topic and a trained adapter. [ADR-0008](./adr/0008-trained-classifier-is-an-optional-overlay.adr.md)
settled that **both paths satisfy the same port** — so compose the cold-start path
(hard rules → retrieval → adjudication) behind that port in `lib/container.ts`.

**Retrieval is rebuilt on the store, not on shipped vectors.** ADR-0018 replaces
ADR-0014's `IEmbeddingReader` (a reader returning `Float32Array`) with a
provenance-addressed query port (exact `fetchChunks` by key + `findSimilar`
discovery returning keyed candidates, never raw vectors); the query text is
embedded store-side by the chunks' declared model, or the match is refused.
`ClassifyByRetrieval` moves its cosine math out of TypeScript and onto that port.
The existing `ClassifyByRetrieval` / `IEmbeddingReader` / embeddings adapter are
**superseded** by this step, not extended.

_Exit: `ClassifyResponseGroup` returns `RequirementClassification[]` for a real
group with no Numbatch running and no samples curated, sourced from the store._

### 2 — Run the money stage

The `money:` section is already in `infra/womblex/redline.yaml` (inert until the
0.3.0 bump; pydantic ignores unknown sections). This step is the *invocation*: a
`womblex money --shards` step after the run. It is not part of `womblex run` /
`worker`, and `money_shards()` takes a local `Path` while the distributed lane
publishes to object storage — so it needs a stage-in / stage-out decision.
Unblocks item 3.

_Exit: a run over a real corpus produces `*.money_spans.parquet` +
`*.money_columns.parquet` siblings in object storage._

### 3 — Currency from table cells, no Numbatch

An `IFinancialExtractor` backed by the money data, mapped to (document,
requirement) via the classification's `sourceChunkId`. Cruder than the Numbatch
financial extension and explicitly a first pass; `architecture.md` §7.4 notes the
extension is the better long-term source. One adapter, and it removes a whole
stack from the critical path.

Read `*.money_spans.parquet` (`locus='table_cell'`, joined on
`(source_hash, parent_elem_order, row, col)`) rather than deriving `isCurrency` at
the seam. The exit test gains a real `Decimal` and an explicit currency, and must
cover a **header-evidenced bare-number column** — the ~98.7% case redline is blind
to today. Supersedes [ADR-0016](./adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md);
decide there whether `derive_is_currency` is retained as a fallback for shards
with no money sidecar. Unblocked by the 0.3.0 bump; still needs item 2.

> **One upstream limitation to carry into the exit test, because no config can
> fix it.** `classify_column` checks vetoes *before* money terms and returns
> early (`money_columns.py:340-344`); the only escape is the header declaring its
> own currency. `rate` is a built-in veto term, and `extra_header_terms` is
> consulted too late to rescue a vetoed column. So `Hourly Rate ($)` classifies
> as money (via `header_currency`) but a bare **`Hourly Rate` / `Day Rate` column
> yields nothing** — a common tender pricing shape. `extra_veto_terms` only adds;
> nothing removes a built-in. If the real corpus hits this, it is an upstream
> change request, not a redline fix.
>
> **The `money:` section in `infra/womblex/redline.yaml` is already written**, and
> its vocabulary was exercised against upstream's real `classify_column`. Every
> term in it is load-bearing — with stock womblex vocabulary, `Subtotal`,
> `Extended`, `RRP`, `Freight` and `Disbursements` columns yield **nothing**
> (header matching is whole-token, so the built-in `total` does not cover
> `subtotal`), while `Cost Centre`, `Payment Terms`, `Value Weighting` and
> `Price Band` are promoted to **money** and would be summed into the pivots as
> prices. The five vetoes exist for that second failure — headers carrying money
> vocabulary that are not money — and each still yields to a header declaring its
> own currency, so `Warranty ($)` survives. Treat the lists as **provisional**
> and tune them against `*.money_columns.parquet` on the first real corpus
> (item 5).

_Exit: the review grid shows numeric AUD for a real tender's priced rows; the
per-brand pivot totals them._

### 4 — The Next.js shell

**The only genuinely missing piece.** React/Next matching Wayfinder's `apps/web`
([ADR-0006](./adr/0006-inherit-wayfinder-auth-roles.adr.md)), serving
`/evaluations/:id/grouping`, `/evaluations/:id/review` (incl. Export to Excel) and
`/evaluations/:id/pivots` over the existing `WorkflowController`. No new logic —
the view models, sorting, filtering, deep links and export are all built and
tested; this renders them. Wires the existing Playwright specs
(`apps/redline-web/e2e/`) into CI, closing the `/e2e` deviation in `CLAUDE.md` and
the browser half of the review-grid / pivots / export work.

_Exit: Playwright green in CI against served routes._

### 5 — Real corpus, end to end

Run a real procurement corpus through: `womblex` profile ingests → the sidecar
extracts, chunks and embeds (see the runbook note below) → vectors materialise
into the `redline_` store (item 1a) → group documents by vendor → classify by
retrieval over the store (item 1b) → render. Extraction provenance still serves as
JSON (ADR-0003/0017); only bulk vectors go to the store. Needs `ISAACUS_API_KEY`
(chunking *and* embedding are Isaacus-gated — see below) and a corpus in the
git-ignored `services/womblex-ingest/tests/corpus-local/`.

Also the owner of one open item: **measure the three OCR-table gates**
(paddleocr-only, deskew refusal, precision refusal) on the real corpus.

> **Two upstream-behaviour facts confirmed on a real 0.3.0 run, to bake into the
> runbook (they are not obvious from the config).** (a) `womblex run` writes
> `elements`/`table_cells`/`form_fields` but **does not persist chunks** — chunking
> and embedding are separate per-stage commands (`womblex chunk --shards` then
> `womblex embed --shards`) over the run's shard dir. (b) The **chunk stage is
> Isaacus-gated** in 0.3.0 (the Kanon-2 tokeniser is API-only), so `ISAACUS_API_KEY`
> is needed for *chunking*, not only embedding — `architecture.md` §7.1's "default
> chunking is offline" is stale and should be corrected there.

_Exit: a specialist opens the review grid for a real tender and sees each
document delineated by topic and brand, with provenance back to source._

---

## 3. Deferred — comprehension lens & release

Deferred until the lean vertical is complete. Revisit **after** item 5 has shown
what the cold-start path actually gets right on a real corpus — that evidence
should shape the lens work rather than be assumed. In dependency order:

| Item | Package(s) | Notes |
|---|---|---|
| Collision selection, ordering & capping | domain | Bounded, deterministic selection of genuinely ambiguous documents. |
| `BoundaryDecision` entity | domain | Net-new modelling. Owns "primary/secondary semantics" (§4.4). |
| Decision persistence + corrections push | adapters | Shrunk: upstream owns corrections + audit — an adapter call over an existing API, not a build. |
| Lens persistence | adapters | `redline_` tables for the lens + its Numbatch bindings (references, not copies). |
| Lens portability | application | Apply a saved lens to a different corpus; its boundary decisions still bite. |
| Lens stage machine | redline-web | Define → map → resolve → save, its own machine. |
| Collision resolution surface | redline-web | View model + controller for resolving a collision set. |
| Sample accrual | adapters | Shrunk: upstream topic-scoped dedupe indexes give re-push idempotence for free. |
| Train/activate policy | adapters | Needs redesign — auto-activation contradicts upstream ADR-0021 (activation is a user-controlled pointer move with a replay diff). Surface the upstream flow: auto-*train* on crossing the floor, then let the specialist activate. |
| Workspace extraction & release prep | workspace | Standalone workspace; sever the vendoring seam; graft the financial overlay onto the fork. Last by nature. |

---

## 4. Carried-forward items

1. **The `content_type` join-key gap is retired — no collision exists.** A real
   0.3.0 run showed womblex assigns `chunk_index` as a single monotonic
   per-document sequence spanning narrative *then* table chunks
   (`process/chunker.py` re-sequences the concatenated list:
   `chunk_index = len(repaired)` — e.g. a real REOI is narrative 0–21, table
   22–29). So `(source_hash, chunk_index)` — redline's two-key `chunkId` — is
   **already unique across content types**; there is nothing to disambiguate.
   `content_type` is kept as **provenance carried alongside a row** (useful to the
   report tools), not as a third join key. `architecture.md` §7.3's collision
   worry should be corrected to say so. No `content_type`-aware `chunkId` and no
   seam-identity change are needed.
2. **Restore `validate.sh` check #13 to a hard `pass`.** The pin-drift guard keeps
   the engine build and the sidecar `womblex==0.3.0` pin honest. Upstream merged
   `0.3.0` on its `main` but never pushed the `v0.3.0` **tag**, so the gitlink
   tracks the merged commit and #13 **warn+skips** (it compares against an exact
   tag by design). This is quiet-by-consent, not silent. When womblex tags
   `v0.3.0`: `git -C services/womblex fetch --tags && git checkout v0.3.0`,
   `git add services/womblex`, and confirm #13 reports
   `pass "womblex pin (submodule v0.3.0 == sidecar pin 0.3.0)"`.
3. **The skill layer points at deleted paths.** `.claude/CLAUDE.md` and all five
   `.claude/commands/*.md` reference `docs/comprehension-lens-design.md`,
   `docs/procurement-evaluation-plan.md` and `docs/threads/` — none of which
   exist. Every code-writing skill fails at its first instruction. They also
   encode a thread-doc lifecycle that `architecture.md` abolished, so this is a
   rewrite against the live documents, not a path fix.
4. **Open questions still owned here** (from the retired lens design): tenancy
   mapping — Numbatch `organisation_id` ↔ Wayfinder identity (needs an ADR before
   a lens is shared between users); primary/secondary semantics (net-new
   modelling — Numbatch returns score-sorted ≤3 topics with no primary/secondary
   distinction; owned by the `BoundaryDecision` item in §3); ambiguity thresholds
   (the signal register needs initial values, unmeasured until a real corpus runs
   — item 5).

---

## 5. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

0. **Ratify [ADR-0017](./adr/0017-bulk-womblex-data-stays-parquet-json-is-for-presentation.adr.md)
   and [ADR-0018](./adr/0018-retrieval-is-a-store-side-query-surface.adr.md)** (both
   Proposed) before any of item 1. They overturn ADR-0014 and set the store the
   retrieval leg is built on; ADR-0018 also carries a store-backing sub-choice
   (`pgvector` vs an ANN index over the shards) that may spawn a follow-on ADR.
1. **Item 1a precedes 1b** — the store must hold the vectors before retrieval can
   query it. Together they replace the old in-TypeScript retrieval leg (the former
   `ClassifyByRetrieval` / `IEmbeddingReader` / embeddings adapter are superseded).
2. **Items 1 (a→b) and 3** are independent of each other. Item 1 unblocks
   classification without Numbatch; item 3 unblocks pricing without Numbatch.
   Item 3 sits behind **item 2** (run the money stage); if that proves slow, run
   **items 1 and 4 first** — item 3 is the only one that needs the money sidecars.
3. **Item 4** — the shell. The only piece that is genuinely new *frontend* code,
   and the only reason the product cannot be looked at today.
4. **Item 5** — the real corpus run. The point of the exercise.

Then, and only then: the deferred lens work (§3) in dependency order, and finally
workspace extraction and release.

### What the lean vertical deliberately does not do

- **No trained classifier, no samples, no adapter.** ADR-0008's first pass only.
- **No Numbatch stack.** Re-enters when a trained overlay or the financial
  extension's roll-up is wanted.
- **No comprehension lens.** Collisions, boundary decisions, lens persistence and
  portability all wait.
- **No workspace extraction.** Ship-shape is a later concern than see-shape.
