# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-07-27
>
> **This tracks outstanding work. It does not restate design.**
> [`architecture.md`](./architecture.md) is the single source of truth for *what
> redline is and how data moves through it*; [`adr/`](./adr/) holds the decisions.
> This file holds *what is left to do* and nothing else.
>
> **Supersedes** the tracking half of
> [`dev-iteration-3.md`](./dev-iteration-3.md). The three `dev-iteration-*.md`
> files are now frozen delivery history in full, exactly as `architecture.md` §6
> already described them — they track nothing. That resolves a standing conflict
> in which `architecture.md` and `dev-iteration-3.md` each claimed to be the
> single source of truth.

---

## 1. What changed, and why this document exists

Two things forced a revision of the plan:

1. **Decision D14 — both upstream engines are consumed as submodules, and their
   existing capabilities are used in preference to rebuilding them.** Threads 37a
   onward were authored *before* this decision. They assumed redline would supply
   its own container, orchestration and staging for the womblex engine.
2. **Initialising `services/womblex` for the first time falsified several
   assumptions those threads were built on** (§3). The submodule had been declared
   in `.gitmodules` since it landed but never initialised, never fetched by CI, and
   never consumed by any build — so the engine's real API surface had never been
   read. Some of what redline built already existed upstream; one binding is
   written against an API that does not exist.

The plan below is the pre-D14 thread list, revised against what the engine
actually provides.

### Decision D14 (new)

**Numbatch and womblex are consumed as git submodules; redline builds on their
shipped capabilities rather than reimplementing them.**

- Mechanism follows runtime: the two **Python** upstreams are submodules; the
  **JavaScript** upstream (Wayfinder) stays a build-time pin, because a submodule
  drags its whole package set into the pnpm workspace (ADR-0012). This is a
  narrower and more honest rule than "one vendoring idiom for both upstreams".
- **This supersedes [ADR-0013](./adr/0013-numbatch-fork-is-materialised-from-a-pin.adr.md)**,
  which decided the opposite for Numbatch ("No submodule"). ADR-0013's stated
  reason was consistency with Wayfinder's pin, and Wayfinder's pin exists for a
  JS-specific reason that does not apply to Numbatch. A superseding ADR is
  **Thread 53** — until it is written, ADR-0013 and this document disagree and
  ADR-0013 is the older of the two.
- Before any thread builds something an upstream may already provide, the
  upstream tree is read first (Thread 54).

---

## 2. The thread contract (unchanged)

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two threads.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.

Numbering continues monotonically so a number never collides with a historical
reference. Threads 37–51 keep the numbers `dev-iteration-3.md` gave them; new
work starts at **52**.

---

## 3. What reading the engine changed

Verified against `services/womblex` @ `v0.2.0` (`2c40e65`), readable in-tree for
the first time.

**Already provided upstream — redline should not build these:**

| Capability | Where, upstream | What redline had built |
|---|---|---|
| Engine container image | womblex's own `Dockerfile` (`ENTRYPOINT ["womblex"]`, `[cloud]` extra) | `Dockerfile.womblex` — **retired** |
| Pipeline orchestration over a corpus | `womblex run` / `process_batch` | a 95-line shell entrypoint looping the CLI per file — **retired** |
| S3/MinIO staging | `store/remote.py` (fsspec; `WOMBLEX_S3_ENDPOINT`, MinIO explicitly supported) | a hand-rolled `mc`/`minio` sync in a heredoc — **retired** |
| Batching, retry, horizontal scale-out | `cloud/queue.py` + `cloud/worker.py` (Postgres job queue, `enqueue`, `worker`, `finalize`) | nothing — a gap redline had simply not filled |

**Confirmed accurate** (no change needed): `architecture.md` §7.1 (chunking is
offline — the Kanon-2 tokeniser is free on Hugging Face), §7.5 (the query-embed
path is `analyse.embed.embed_texts` + `cli._shared.make_isaacus_client`).

**Falsified:** `architecture.md` §2/§3 describe womblex's OCR as "PaddleOCR" and
§8 as `rapidocr-onnxruntime`. Both name the same thing — `engine: paddleocr` is
the *config value*, rapidocr the implementation. Imprecise, not contradictory.

**Still redline's own, correctly** — do not dissolve these into the engines: the
domain, the comprehension lens, the control surface, and the nearest-neighbour
matching in `ClassifyByRetrieval`. `womblex/analyse/query.py` is an internal
enrichment-graph loader for PII, explicitly *"not an end-user query API"*; womblex
produces embeddings, redline ranks them.

**Open — the largest remaining reuse question:** womblex exposes
`kanon-universal-classifier` (zero-shot classification) and
`kanon-answer-extractor` (structured field extraction) via Isaacus. redline
instead built a Numbatch fork extension for currency extraction (795 LOC + 7 test
files, Threads 6–8), and Threads 49–50 exist solely to feed Numbatch's
10-samples-per-topic training floor. `architecture.md` §7.6 already flags the
overlap. **Thread 54 settles it before Track L builds on the assumption.**

---

## 4. Build state

| # | Thread | Track | Package(s) | Status |
|---|---|---|---|---|
| 37a | womblex pod (test harness) | H | infra | ⛔ **retired** — the engine ships its own image, runner and staging (§3). Replaced by the `womblex` compose profile building `services/womblex` + `scripts/womblex-engine-smoke.sh`. |
| 37b | Real womblex binding | H | womblex-ingest | 🔴 **blocked — defect** (§5) |
| 38 | In-app review grid | P | redline-web | ✅ **verified** — 63/63 green; currency sorts numerically, source deep-links carry element/page/chunk. Browser leg → 41. |
| 39 | Pricing pivots | P | application, redline-web | ✅ **verified** — pivots match hand-computed totals and the frozen Wayfinder roll-up. |
| 40 | Excel export | P | redline-web | ✅ **verified** — real `Number` cells, blank-not-zero, hyperlink source column; `write-excel-file@4.1.1` wired. "Workbook opens" → 41. |
| 52 | womblex submodule wiring | H | infra, workspace | ✅ **done** (this change) — CI fetches submodules; `validate.sh` #13 guards pin drift; static guards exclude the vendored tree. |
| 53 | Numbatch submodule + superseding ADR | H | infra, docs | 🔵 **next** |
| 54 | Upstream capability audit | H | docs | 🔵 **next** |
| 41 | Next.js shell | H | redline-web | ⚪ not started — closes the `/e2e` deviation and the browser half of 38–40. |
| 42 | Collision selection, ordering & capping | L | domain | ⚪ not started |
| 43 | `BoundaryDecision` entity | L | domain | ⚪ not started |
| 44 | Decision persistence + corrections push | L | adapters | ⚪ not started |
| 45 | Lens persistence | L | adapters | ⚪ not started |
| 46 | Lens portability | L | application | ⚪ not started |
| 47 | Lens stage machine | L | redline-web | ⚪ not started |
| 48 | Collision resolution surface | L | redline-web | ⚪ not started |
| 49 | Sample accrual | L | adapters | ⚪ not started — **may be retired by Thread 54** |
| 50 | Train/activate policy | L | adapters | ⚪ not started — **may be retired by Thread 54** |
| 55 | Retire the air-gap machinery | H | womblex-ingest, redline-web | ⚪ not started (§6) |
| 51 | Workspace extraction & release prep | H | workspace | ⚪ not started — last by nature |

---

## 5. Thread 37b is blocked on a verified defect

`RealWomblexTextEmbedder.__init__` (`services/womblex-ingest/src/womblex_ingest/real_extractor.py:159`) does:

```python
from womblex import embed_query, embedding_model_id
```

Neither symbol exists. `womblex/__init__.py` exports nothing, and
`embed_query` / `embedding_model_id` appear nowhere in the engine's source.
Constructing the embedder under `WOMBLEX_MODE=real` raises `ImportError`, so the
query-embedding half of the binding cannot work — and therefore neither can
retrieval, which is the whole cold-start classification path.

`architecture.md` §7.5 **documented this exact gap** ("There is no
`womblex.embed_query` / public embedding helper") but the correction was never
applied to the code. The unit tests pass because they exercise the mapping with
plain row dicts and never construct the real embedder.

The verified call is:

```python
from womblex.analyse.embed import embed_texts
from womblex.cli._shared import make_isaacus_client

embed_texts([text], make_isaacus_client(),
            model="kanon-2-embedder", task="retrieval/query")
```

Note `task="retrieval/query"` must pair with the chunk vectors'
`task: retrieval/document` (set in `infra/womblex/redline.yaml`), and the model
must match or ADR-0014 refuses the comparison.

**Thread 37b's first task is this fix, with a test that actually constructs the
embedder.** Sequenced before Track L, per the original plan's reasoning: the lens
work should not stack further on a stub.

---

## 6. Carried-forward items

1. **Air-gap retirement (Thread 55).** `dev-iteration-3.md` §5 and
   `architecture.md` §2/§7/§8/§9 all declare the Isaacus-optional / air-gap
   posture retired and cite "ADR-0008 (amended)". **ADR-0008 is not amended** —
   it is unchanged from 2026-07-24 and never mentions air-gap or `OFFLINE`. The
   machinery is meanwhile live and green: `EnrichmentMode.OFFLINE`
   (`config.py`/`main.py`/`extraction.py`), `test_airgap_pipeline.py`,
   `test_enrichment_mode.py`, `scripts/thread-15-airgap.sh`, `ingest-config.ts`
   and its e2e spec. Thread 55 either writes the amendment and deletes the
   machinery, or drops the claim. It must not stay half-declared.
2. **The `content_type` join-key gap** (`architecture.md` §7.3). womblex joins
   vectors to chunks on `(source_hash, chunk_index, content_type)`; redline's
   `chunkId` collapses that to two keys, so narrative and table chunks at the same
   index collide. Unresolved, and it bites on exactly the table-heavy tender
   corpora redline targets. Fold into Thread 37b's real-corpus proof.
3. **The skill layer points at deleted paths.** `.claude/CLAUDE.md` and all five
   `.claude/commands/*.md` reference `docs/comprehension-lens-design.md`,
   `docs/procurement-evaluation-plan.md` and `docs/threads/` — none of which
   exist. Every code-writing skill fails at its first instruction. They also
   encode a thread-doc lifecycle that `architecture.md` abolished, so this is a
   rewrite against this document, not a path fix.
4. **Open questions** from `dev-iteration-2.md` §9, still owned here: tenancy
   mapping (#3), primary/secondary semantics (#4 → Thread 43), ambiguity
   thresholds (#5, unmeasured until a real corpus runs).

---

## 7. Sequencing

1. **53, 54** — finish D14. Add Numbatch as a submodule with its superseding ADR
   (which also unblocks the four dead `infra/docker/*.Dockerfile` compose
   references that have made the `numbatch` profile unstartable), then audit both
   readable trees. 54 gates Track L: if `kanon-answer-extractor` covers
   currency-with-provenance, Threads 6–8's overlay and Threads 49–50 shrink or go.
2. **37b** — fix the embedder defect, then prove retrieval sorts a real corpus.
   Gates the semantic honesty of everything downstream.
3. **41** — the shell; closes the browser half of 38–40 and the `/e2e` deviation.
4. **42–50** — Track L, in dependency order, scoped by 54's findings.
5. **55** — the air-gap retirement, any time; it is cleanup, not a dependency.
6. **51** — workspace extraction and release, last by nature.
