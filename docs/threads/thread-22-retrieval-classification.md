# Thread 22 — Retrieval classification

**Status:** ✅ Complete · **Date:** 2026-08-06 · **Version intent:** MINOR (pre-1.0; new domain port + new adapter + new use-case, additive, no existing behaviour changed)

Design entry: [`docs/comprehension-lens-design.md` §3, §6 · Track L](../comprehension-lens-design.md)
· rests on [ADR-0014](../adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) (settled — no new ADR)
· consumes Thread 20 ([`IEmbeddingReader`](./thread-20-embedding-reader.md), the chunk vectors) **and** Thread 20a ([the query-embedding endpoint](./thread-20a-sidecar-text-embedding-endpoint.md), the query vector)
· the first-pass classification path's second leg, after Thread 21's [hard-rule pre-pass](./thread-21-hard-rule-pre-pass.md)

## Goal

Build the lens's **model-free** classification stage (design doc §3, "retrieval →
clear match"): rank a document's chunk vectors against each topic definition by
cosine similarity and assign the document to the best-matching topic. No trained
Numbatch adapter, no curated samples — this is the point at which the workflow
first classifies a corpus with nothing but womblex's embeddings (ADR-0008, D2).

**Exit test:** a fixture corpus classifies with no trained adapter and no samples.

## Why this thread needed both 20 and 20a

Retrieval is a comparison between two vectors, and until this thread only one
side existed in TypeScript:

- **Thread 20** reads the *chunk* vectors (`IEmbeddingReader` →
  `DocumentEmbeddings`, `Float32Array`, cached per evaluation).
- **Thread 20a** built the sidecar's `POST /embeddings/query`, but nothing in
  TypeScript called it — there was no port and no adapter for the *query* side.

So this thread carries the missing query-side seam (`ITextEmbedder` +
`WomblexTextEmbedder`) as well as the use-case that composes both. That is why it
spans `application` **and** `adapters` (plus a small `domain` port) — the design
doc's row 22 names exactly that.

## What was built

Three packages, one seam each, one commit — the use-case is the deliverable; the
port and adapter are the query side it could not exist without.

### New — `packages/redline-domain/src/ports/text-embedder.ts`

| Symbol | Contents |
|---|---|
| `QueryEmbedding` (`model`, `dimensions`, `values: Float32Array`) | One query vector. `model` is load-bearing — a query is comparable to a chunk vector only when both declare the same model (ADR-0014). `values` is a `Float32Array`, the same representation the chunk vectors cross under, so the match is a dot product. Chunk-free: a query is never persisted and carries no join key (Thread 20a). |
| `ITextEmbedder.embed(text)` | `Promise<Result<QueryEmbedding>>`. Blank text is a `VALIDATION_FAILED` at the seam, not a zero vector. |

A 2-test port-conformance suite (`text-embedder.test.ts`) pins the shape with an
in-memory fake, exactly as the Thread 20 `embedding-reader.test.ts` does.
`Float32Array` is a JS built-in, so `redline-domain` keeps its zero-dependency
purity (check #4 green).

### New — `packages/redline-adapters/src/embeddings/womblex-text-embedder.ts`

`WomblexTextEmbedder implements ITextEmbedder` over an injected method-aware
`HttpClient`, POSTing `{ text }` to `POST /embeddings/query` (Thread 20a). It:

- narrows the response through `text-embedder-wire.ts` — the one place that trusts
  the wire, parsing `values` into a `Float32Array` and **rejecting a query whose
  length disagrees with its declared `dimensions`** (an unmatchable vector fails
  at the seam, matching the chunk reader's posture);
- **caches by text**, so Thread 22's handful of topic definitions embed once, not
  once per document (only successful embeds are cached — a transient failure
  retries);
- catches blank text *before* the round trip and speaks the same
  `VALIDATION_FAILED` the sidecar's `INVALID_REQUEST` maps to;
- maps transport / non-JSON / non-2xx failures to `INFRA_FAILURE` — nothing
  throws across the port edge.

`__fixtures__/query-embedding.json` is a capture of the sidecar's stub query
response (a sibling note in the fixtures `README.md`): same declared
`model`/`dimensions` as the chunk-vector fixture, L2-normalised, chunk-free.

### New — `packages/redline-application/src/use-cases/classify-by-retrieval.ts`

| Symbol | Contents |
|---|---|
| `ClassifyByRetrieval` (`{ embeddingReader, textEmbedder }`) | The use-case. Embeds each topic definition **once** up front, then for each requested document reads its chunk vectors and returns the single strongest `(topic, chunk)` pair as a `RequirementClassification`. |
| `ClassifyByRetrievalInput` (`request`, `topics`) | The `ClassificationRequest` context and the lens's `Topic`s (may be empty). |
| `ClassifyByRetrievalDependencies` | The two injected ports: the chunk-vector reader (Thread 20) and the query embedder (this thread's adapter). |

The similarity is a plain dot product because both vectors cross L2-normalised
(ADR-0014) — no re-normalisation. A document is assigned to **one** requirement
here; multi-label splitting is a boundary decision (Thread 27), not a retrieval
concern.

### Modified — the two package `index.ts`

`redline-domain` re-exports the `text-embedder` port; `redline-adapters` exports
`WomblexTextEmbedder` (+ its HTTP seam types); `redline-application` exports
`ClassifyByRetrieval` and its input/dependency types under a "first-pass
classification (Thread 22)" heading.

## Design decisions

No new ADR — the thread rests on ADR-0014 (the wire), ADR-0008/D2 (the optional
overlay and port interchangeability) and ADR-0010/D11 (topic id = requirement
id). Choices worth recording:

- **The matched topic's id is the `requirementId` directly.** Per ADR-0010 a
  topic's identity carries into the requirement it projects to, so retrieval
  writes `topic.id` into `requirementId` with no mapping table — the same move
  the hard-rule pre-pass (Thread 21) makes.
- **`confidence` is the cosine similarity; `sourceChunkId` is the chunk that
  carried it.** Both paths emit the same `RequirementClassification` shape (D2):
  a downstream cannot tell a retrieval row from a Numbatch row *by its shape*.
  Unlike the hard-rule row (`confidence: 1`, `sourceChunkId: null`), a retrieval
  row names the strongest chunk, because retrieval *did* rank body text.
- **A model mismatch refuses rather than ranks.** If a document's declared model
  differs from the query's, the vectors are incomparable and the use-case returns
  `VALIDATION_FAILED` rather than producing a meaningless score (ADR-0014). This
  is the consumer-side enforcement Thread 20a limitation 3 owed.
- **An absent embeddings shard is skipped, not fatal.** `NOT_FOUND` from the
  reader means the embed stage is an optional overlay that did not run for that
  document (ADR-0014, D10): the document is skipped and the rest of the corpus
  proceeds. A corpus of only shard-less documents yields an empty result, not an
  error.
- **Each definition is embedded once.** The query vectors are computed up front
  and reused across every document — the adapter's per-text cache makes this a
  belt-and-braces guarantee, but the use-case does not re-embed per document
  regardless.
- **No orchestrator.** This is one independent leg of §3, composed by the caller,
  not chained to Thread 21 or Thread 23 (D4).

## Exit-test evidence

```
@redline/redline-domain:test   ✓ src/ports/text-embedder.test.ts (2 tests)
                               Tests  99 passed (99)   [was 97; +2]
@redline/redline-adapters:test ✓ src/embeddings/womblex-text-embedder.test.ts (11 tests)
                               Tests  69 passed (69)   [was 58; +11]
@redline/redline-application:test ✓ src/use-cases/classify-by-retrieval.test.ts (9 tests)
                               Tests  33 passed (33)   [was 24; +9]
```

Against the stated exit criterion:

| Exit criterion | Covered by |
|---|---|
| **a fixture corpus classifies with no trained adapter and no samples** | `classify-by-retrieval.test.ts` "classifies a fixture corpus with no trained adapter and no samples" — two documents, two topic definitions embedded through the fake `ITextEmbedder`, each document lands on the correct topic by dot product. No classifier port is present in the use-case at all. |

Beyond the stated criterion:

| Property | Covered by |
|---|---|
| interchangeable shape (D2) | "emits the RequirementClassification shape" pins the exact key set |
| strongest chunk, not first | "names the strongest chunk as the source, not merely the first" |
| embed once per definition | "embeds each topic definition once, not once per document" |
| skip absent overlay (D10) | "skips a document with no embeddings shard rather than failing the run"; "returns an empty result for a corpus of only shard-less documents" |
| model-mismatch refusal | "refuses to rank chunks whose model differs from the query's" |
| error propagation | "propagates a text-embedder failure unchanged" |
| no topics → no rows | "returns no rows when the lens has no topics to match against" (and no embeds) |
| adapter contract | `womblex-text-embedder.test.ts` — captured fixture → `QueryEmbedding` (`Float32Array`, L2-normalised), POSTs to the query seam, caches by text, error taxonomy (`VALIDATION_FAILED` / `INFRA_FAILURE`), dimension-mismatch rejection, blank-text short-circuit |

Purity checks stay green: `redline-domain` (#4) links no dependency (the new port
is plain data over a JS built-in); `redline-application` (#5) imports only
`@redline/redline-domain`.

`./validate.sh` — **12/12 PASS, Failed: 0.**

## Known limitations / follow-ups

1. **No Clear/Ambiguous bucketing yet.** This thread produces a score per
   document; it does *not* decide whether that score is a clear match or an
   ambiguous one. The ambiguity signal register and the Clear/Ambiguous
   derivation are **Thread 24** — retrieval hands it a ranked assignment, the
   signals decide the bucket. There is deliberately no threshold here (open
   question #5 is unmeasured).
2. **Single-label assignment.** A document is assigned to its single strongest
   topic. Primary/secondary/split is a **boundary decision** (Thread 27,
   net-new modelling), not a retrieval output.
3. **The unclaimed remainder still flows on to Thread 23.** What retrieval leaves
   genuinely unclear is the LLM adjudicator's input; composing pre-pass →
   retrieval → adjudication is the caller's job (no orchestrator, D4), wired in
   the container, not here.
4. **The stub embedding space is not semantic** (Thread 19 limitation 6, Thread
   20a limitation 2). The fixture corpus uses hand-chosen orthogonal unit vectors
   so nearest-neighbour is unambiguous *by construction*; retrieval *quality*
   against real womblex vectors is only provable once real mode is wired
   (`RealWomblexTextEmbedder`/`RealWomblexExtractor` still raise).
5. **The adapter's text cache is per-instance and unbounded** — correct for an
   evaluation's handful of definitions (the same posture as the Thread 20 reader
   cache, limitation 2), but bound it if a single embedder is ever shared across
   many lenses.
6. **No live sidecar round trip here** (no container runtime — same posture as
   Threads 5–20a). The query-seam contract is pinned against a captured payload on
   the TS side and `test_query_embedding_api.py` on the Python side; the
   compose-up proof lands with the other owed service proofs (Thread 16).
