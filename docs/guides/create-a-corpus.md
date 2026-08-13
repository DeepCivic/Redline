# Creating a corpus

**Who this is for:** whoever holds the documents — the person who has a tender's
responses and needs them read.

This is the guide to the **Create Corpus** screen. It does one job: **it builds
the dataset.** Point it at the raw documents in your bucket, pick the extraction
parameters and the stages the engine puts them through, name it if you want,
click go.

There is no field selection here and nothing to decide about the tender itself.
Deciding what to *read out of* the corpus happens afterwards, on
[Creating an evaluation](./create-an-evaluation.md). Two jobs, usually two
people, which is why they are two screens — and if someone else has already run
the documents, you do not need this screen at all.

> **Status.** The screen does what this guide describes. One thing about a
> *finished* corpus is still catching up — see
> [What is not there yet](#what-is-not-there-yet) at the end.

The screen is served by the forked Wayfinder, not by a standalone redline app.
See [Running both stacks locally](./two-stack-local-run.md) for how to get it up.

---

## Before you start

- **You need the `evaluation:create` permission** (admins hold it through the
  admin wildcard). Without it the sidebar entry is hidden and the route is not
  served.
- **The ingest sidecar must have its run trigger configured.** It needs a
  database DSN and a store URI; without them the run endpoints answer *"run
  trigger is not configured"*. Check `curl -s localhost:8000/health` before
  blaming the form.
- **Check which womblex lane you are on.** `"womblexMode":"real"` on that same
  health response means real extraction. `"stub"` is a dependency-free test
  double that serves deterministic *fabricated* documents — a run left on it
  looks like it succeeded while showing invented content.

## Getting there

**Create Corpus** in the sidebar.

---

## 1. Name the run

A corpus is one womblex run, and you name it. "One run" means one extraction and
the paths cut from it under a single identity — not one pass building everything
top-to-bottom (see [Choose the stages to run](#3-choose-the-stages-to-run)). The
name you type is that identity all the way down: it is the bucket prefix the
documents are read from, the prefix the results are written to, and later the id
of the evaluation built over them. They are one thing, not three that have to be
kept in step.

Type something you will recognise in a fortnight — `water-treatment-2026`, not
`test3`. Reuse a name and you are adding to that corpus rather than starting a
new one, so pick a fresh one unless that is what you meant.

## 2. Point at the documents

Add the tender responses — the submissions, the pricing schedules, the annexures.
They come from the raw documents in your bucket (e.g. S3), under the run's input
prefix, and sit there until you start the run; nothing reads them before that.

You do not identify or label them here. The engine assigns each document its
identity when it extracts it, and saying *whose* response a document is happens
on the evaluation screen afterwards, once those identities exist. That ordering
is the whole reason these are two screens.

## 3. Choose the stages to run

Extraction runs first and once. Everything else hangs off its checkpoints, and
it does **not** run as one long chain — after extraction the work forks into two
independent paths that share nothing but the extraction they were both cut from:

**Path 1 — pricing.** *Money* reads the extraction checkpoints directly and
finds and types the amounts the pricing pivots are built from. It is a separate,
offline pass; it does not wait on chunking or embedding and nothing downstream of
it is on this path. This is the path you care about when you are after the money.

**Path 2 — the rich corpus.** *Chunk → Embed → Enrich*, in that order, so the
corpus is navigable and retrievable: chunk splits the extracted documents, embed
produces the vectors retrieval reads by, enrich runs the entity and graph pass
(and enrich must follow chunk, or its entities land unjoinable to chunk text).

| Stage | Path | What it does |
|---|---|---|
| Money | 1 — pricing | Finds and types the amounts, straight off the extraction checkpoints. |
| Chunk | 2 — rich corpus | Splits the extracted documents into chunks. |
| Embed | 2 — rich corpus | Produces the vectors retrieval reads by. |
| Enrich | 2 — rich corpus | Runs the entity and graph enrichment pass, after chunk. |

The two paths are **deterministically linked back to each other through the
extraction they share** — money offsets live in the same coordinate space as the
chunks (both keyed to the extracted elements), so a figure Path 1 found maps to
the chunk Path 2 produced without either path having to know the other ran. That
is the whole reason this can fork: run the paths separately, join on the
extraction. It is *not* one run built top-to-bottom in a single pass, and trying
to force it into one would corrupt the data.

All four are on by default. Leave them alone unless you have a reason. Turning a
stage off removes it and nothing else: switching Money off does not touch Path 2,
and vice versa. Within Path 2 the **order** is not yours to set — the sidecar
enforces chunk before embed and enrich after chunk. Only these four are offered;
the structural stages are not run parameters and the engine refuses them.

## 4. Author the run config (optional)

Everything here inherits the corpus profile's default when you leave it alone.
The editors only appear once you switch a group on.

**Extraction and OCR** — this is the one pass both paths depend on, so its
settings matter most, and it is the first group you can switch on. For scanned
documents the OCR engine is the setting that matters most of all: the default
`paddleocr` detects regions, which is what lets the engine reconstruct table
cells on a scanned page. A vision-language engine returns prose with no regions,
so it deletes every table cell on a scanned page — and with them all the pricing
on a scanned tender, which starves Path 1 before it runs.

- *OCR engine* — the engine name, `paddleocr` by default. Name a region-based
  engine for scanned tenders; a VLM engine drops table cells, and with them the
  pricing.
- *OCR dpi* — the render resolution for OCR'd pages, a whole number between 72
  and 600. Defaults to 200.

These are authorable on a first run because a first run has nothing yet to
orphan and is the run that meets that corpus. They are refused on a re-run of an
already-extracted corpus, where changing them would leave the paths cut from the
old extraction unjoinable to the new one.

**Chunk mode**

- *Chunk size (tokens)* — a whole positive number. Defaults to 480.
- *Chunk tables* — whether tables are chunked. On by default.

**Money vocabulary**

- *Default currency* — three-letter ISO code, `AUD` by default. What a bare
  number inherits when its column or prose declares no currency.
- *Extra header terms* — comma-separated tender-schedule headers the built-in
  money vocabulary misses.
- *Extra veto terms* — comma-separated headers that collide with a built-in money
  term without being money.

Terms are lower-cased and de-duplicated for you; a blank term or a currency that
is not three letters is refused before the run starts.

Two things are never offered, on any run: the embedding model and its task,
because the chunk vectors have to pair with the vectors used at search time and
that is not a per-corpus choice; and the Isaacus gate.

## 5. Start it and watch

The form is replaced by the run tracker, which polls until the run settles. A
real run takes minutes.

| What you see | State |
|---|---|
| *Extracting documents* | The engine is extracting — the pass both paths depend on; the tracker shows **Running…** |
| *Running stages* | Extraction is done and the two paths are working off its checkpoints. |
| *Completed: chunk · embed · money* | The stages finished so far, named as they land. |
| *Run complete* | Both paths have settled. |
| *&lt;Stage&gt; stage failed* + the engine's message | The named pass failed. |

Stages land as they finish, not in one strict marching order — Path 1's money and
Path 2's chunk/embed/enrich are separate work off the same extraction, so the
tracker names each as it completes rather than implying a single chain.

**A failed run is never a dead end.** It names the stage that failed and offers
**Resume run**, which re-fires the same run rather than starting a new one: the
engine's enqueue is idempotent and completed stages skip on their published
outputs, so it picks up where it stopped. Safe to press more than once.

The tracker stops polling once the run settles, so a failed run will not spin
forever.

## What happens next

A finished run leaves a dataset: the documents extracted, chunked and processed
through whichever stages you chose. Nothing has been evaluated — no brands, no
fields, no report. The tracker offers the way on to
[Creating an evaluation](./create-an-evaluation.md), where the corpus you just
built appears in the picker and you say what you want answered about it.

---

## What is not there yet

- **AI chunking is refused, deliberately.** Leaving the chunk-mode override off,
  or setting only the size and table options, works. Naming a chunking *model*
  is rejected with a message saying why: it makes chunking a per-document
  Isaacus call and requires enrich to run before chunk or every document is
  enriched twice at double cost — an ordering the stage toggles cannot express.
  It is refused rather than quietly ignored so the bill is never a surprise.

- **A corpus extracted outside this screen is a different path.** This screen
  starts a corpus from the raw documents in your bucket. If someone has already
  run one, you do not need this screen — go straight to
  [Creating an evaluation](./create-an-evaluation.md). `POST /ingest` still
  loads a corpus extracted outside a browser-fired run; a run fired *here* loads
  its own shards when it finishes, so no separate ingest step is needed.
