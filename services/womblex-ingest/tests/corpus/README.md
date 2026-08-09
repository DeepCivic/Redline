# womblex engine fixture corpus

A tiny, redistributable document set the `womblex` compose profile extracts as
its smoke test (`scripts/womblex-engine-smoke.sh`). womblex routes by file
extension; a CSV takes the pandas cell-grained ingest path (README "Other
formats"), needs no binary blob in the repo, and is safe to redistribute.

`tender.csv` is a **fully synthetic, abstracted** procurement tender-response
dataset. It is modelled on the *breadth and structure* of a real REOI response
set (capability-domain responses, compliance/ownership declarations, security
certifications, data-residency posture, currency-typed pricing) but contains **no
real entity, contact, identifier or verbatim content** — every value is
invented and generic. It carries enough structure and breadth for the real
engine to produce meaningful `*.elements` / `*.chunks` shards, and (with an
Isaacus key) real `*.embeddings.parquet`.

Breadth deliberately baked in, so extraction/chunking (and later retrieval) have
something to bite on:

- **Three respondents (A, B, C)** across **seven capability domains** (Access
  Control, Device Management, Reporting, Hosting, Support, Delivery, Compliance).
- A **contrast axis**: two compliant onshore respondents vs. one non-compliant
  offshore respondent (foreign-controlled, no sovereign accreditation, USD
  pricing) — a real signal for classification/retrieval to separate.
- **Currency-typed amounts** in two currencies (AUD/USD) with genuine blanks, so
  the currency-cell path and null handling are both exercised.

Not a benchmark corpus: it exists to prove the engine runs and lands shards, not
to measure retrieval quality (that is Thread 37b's proof, and the
ambiguity-threshold measurement is a further follow-up). Non-redistributable /
real documents belong in the git-ignored sibling `corpus-local/`, not here.

Override the corpus with a real document set via `WOMBLEX_CORPUS=/path up`.

## `redline-manifest.json` — redline's half of the fixture run

`tender.csv` is what the *engine* eats. `redline-manifest.json` is what
**redline** needs on top of it: the vendors, the response groups and the
classification lens, which the served grouping page cannot yet author. It is the
`<manifest.json>` argument to the fork's corpus driver:

```
pnpm --filter @wayfinder/web exec tsx scripts/seed-redline-evaluation.ts \
  ../../../womblex-ingest/tests/corpus/redline-manifest.json
```

**It describes a `WOMBLEX_MODE=stub` run, and the ordering is forced.**
`groups[].documentIds` are womblex `source_hash` values, which do not exist until
the sidecar has ingested — so the manifest is written *after* `POST /ingest`, not
before it. The ids below were taken from `StubWomblexExtractor.extract()`, the
same call `POST /ingest` makes, for `evaluationId: redline-fixture-tender` and
the document names in the table. Change either and every id changes with it.

The stub is **deterministic and does not read the corpus**: it synthesises each
document's elements and chunks from the *name* it is given, so the 15 names below
are the response-pack shape a real tender arrives in — one document per
`tender.csv` row — rather than files on disk. A `WOMBLEX_MODE=real` run over this
corpus stages one CSV and yields one `source_hash`, so it needs its own manifest.

Post them in exactly this order:

```json
{"evaluationId": "redline-fixture-tender", "documentNames": [ … the table below … ]}
```

| Document name | `documentId` (`source_hash`) |
|---|---|
| `respondent-a-req-01-access-control.csv` | `1d5b0965d067342d` |
| `respondent-a-req-02-device-management.csv` | `24b81322942c06e4` |
| `respondent-a-req-03-reporting.csv` | `ac4d08ee5affdbc6` |
| `respondent-a-req-04-hosting.csv` | `ba177477f68b7674` |
| `respondent-a-req-05-support.csv` | `68f59805fe7d0cd9` |
| `respondent-b-req-01-access-control.csv` | `d8c7617f6ba54fa0` |
| `respondent-b-req-02-device-management.csv` | `52617ea16424f293` |
| `respondent-b-req-03-reporting.csv` | `3990a8f4d1c980be` |
| `respondent-b-req-04-hosting.csv` | `4b2fcb5adf4643c4` |
| `respondent-b-req-06-delivery.csv` | `e9e39c1c238ae37f` |
| `respondent-c-req-01-access-control.csv` | `472f4d5b630294e8` |
| `respondent-c-req-02-device-management.csv` | `e4e65a4470de4888` |
| `respondent-c-req-03-reporting.csv` | `3d8785b3a084a9ce` |
| `respondent-c-req-04-hosting.csv` | `e3c61a18a52b5af7` |
| `respondent-c-req-07-compliance.csv` | `c6763495af8fbc59` |

### What the run is meant to show

**One grid row per document.** The cold-start classifier assigns each document
exactly one requirement, and `BuildEvaluationTable` emits one
`ProcurementResponse` per (group, document, matched requirement) — so 15
documents is 15 rows, and a row's vendor is its group's first vendor. Three
groups, one per respondent, is what delineates the grid by brand.

**Fourteen rows exercise the adjudicator; one does not.** The stub's chunk text is
`"{name}: chunk 0"`, so the passages the adjudicator sees carry the document's
own name. That makes the weakest connector in the stack checkable rather than
merely exercised: each adjudicated row should land on the topic its name states,
and a row that does not is a real finding about
`REDLINE_ADJUDICATOR_BASE_URL`'s contract.

**The fifteenth row proves the deterministic leg.** The single hard rule
(`*-req-07-*` → `fixture-compliance`) claims
`respondent-c-req-07-compliance.csv` before the store or the model is touched, so
that row carries `confidence: 1` and a **null** `sourceChunkId`. This is
deliberately the only rule: the manifest is now the only path that can write hard
rules at all, and one rule proves the leg without pretending we know enough about
this corpus to write more.

Topic ids are namespaced `fixture-*` because `redline_topics.id` is a plain
primary key — a topic belongs to exactly one lens, so an unprefixed
`access-control` would collide with the next lens that wants one. The id is also
the `requirementId` the review grid prints in its Requirement column, which is
why it stays readable rather than being scoped with the corpus id.
