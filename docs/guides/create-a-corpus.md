# Creating a corpus

**Who this is for:** whoever holds the documents — the person who has a tender's
responses and needs them read.

This is the guide to the **Create Corpus** screen. It does one job: **it builds
the dataset.** Upload the documents, pick the extraction parameters and the
stages the engine puts them through, name it if you want, click go.

There is no field selection here and nothing to decide about the tender itself.
Deciding what to *read out of* the corpus happens afterwards, on
[Creating an evaluation](./create-an-evaluation.md). Two jobs, usually two
people, which is why they are two screens — and if someone else has already run
the documents, you do not need this screen at all.

> **Status.** The screen now does what this guide describes. One thing is not
> offered yet — extraction and OCR settings — and one caveat applies to which
> build you are running: see [What is not there yet](#what-is-not-there-yet) at
> the end.

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

A corpus is one womblex run, and you name it. The name you type is the run's
identity all the way down: it is the folder the documents are uploaded to, the
folder the results are written to, and later the id of the evaluation built over
them. They are one thing, not three that have to be kept in step.

Type something you will recognise in a fortnight — `water-treatment-2026`, not
`test3`. Reuse a name and you are adding to that corpus rather than starting a
new one, so pick a fresh one unless that is what you meant.

## 2. Upload the documents

Add the tender responses — the submissions, the pricing schedules, the annexures.
They upload to the run's input folder and sit there until you start the run;
nothing reads them before that.

You do not identify or label them here. The engine assigns each document its
identity when it extracts it, and saying *whose* response a document is happens
on the evaluation screen afterwards, once those identities exist. That ordering
is the whole reason these are two screens.

## 3. Choose the stages to run

The downstream passes the engine runs after extraction:

| Stage | What it does |
|---|---|
| Chunk | Splits the extracted documents into chunks. |
| Embed | Produces the vectors retrieval reads by. |
| Enrich | Runs the entity and graph enrichment pass. |
| Money | Finds and types the amounts the pricing pivots are built from. |

All four are on by default, matching the sequence the corpus profile ships. Leave
them alone unless you have a reason.

The **order** is not yours to set: the sidecar normalises the sequence and
enforces the dependencies (chunk before embed). Turning a stage off removes it;
it never reorders the rest. Only these four are offered — the structural stages
are not run parameters and the engine refuses them.

## 4. Author the run config (optional)

Everything here inherits the corpus profile's default when you leave it alone.
The editors only appear once you switch a group on.

**Extraction and OCR** — available on a first run, which is this one. The OCR
engine is the setting that matters: the default (`paddleocr`) detects regions,
which is what lets the engine reconstruct table cells on a scanned page. A
vision-language engine returns prose with no regions, so it deletes every table
cell on a scanned page — and with them all the pricing on a scanned tender.
Change it only if you know your documents are not scanned, and know what you are
giving up.

You get these on a first run because there is nothing yet to break. Re-running a
corpus that already has results is different: changing extraction there
invalidates everything built on top of it, so the screen refuses it.

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
| *Extracting documents* | The engine is extracting; the tracker shows **Running…** |
| *Running stages* | Extraction is done and the downstream sequence is going. |
| *Completed: chunk · embed* | The stages finished so far, in run order. |
| *Run complete* | Done. |
| *&lt;Stage&gt; stage failed* + the engine's message | The named pass failed. |

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

- **Extraction and OCR settings are not offered.** Everything else on the screen
  is authorable; these are not, so a run extracts with whatever
  `infra/womblex/redline.yaml` sets. That matters most for scanned documents:
  the profile marks `extraction.ocr.engine: paddleocr` load-bearing, because a
  VLM engine returns markdown with no regions and so drops every table cell on a
  scanned page. Edit `redline.yaml` if you need something else. The delivery plan
  tracks widening this for a first run.

- **AI chunking is refused, deliberately.** Leaving the chunk-mode override off,
  or setting only the size and table options, works. Naming a chunking *model*
  is rejected with a message saying why: it makes chunking a per-document
  Isaacus call and requires enrich to run before chunk or every document is
  enriched twice at double cost — an ordering the stage toggles cannot express.
  It is refused rather than quietly ignored so the bill is never a surprise.

- **Uploading an already-extracted corpus is a different path.** This screen
  starts a corpus from raw documents. If someone has already run one, you do not
  need this screen — go straight to
  [Creating an evaluation](./create-an-evaluation.md). `POST /ingest` still
  loads a corpus extracted outside a browser-fired run; a run fired *here* loads
  its own shards when it finishes, so no separate ingest step is needed.

> **Which build you are running.** The split above is committed but the forked
> Wayfinder mount it lives in has not been pinned into redline yet (the fork
> branch has to merge to the fork's `main` first). A deployment built from
> redline's current pin still serves the older screen, which asks for brands and
> fields and picks a corpus rather than naming one. The delivery plan tracks the
> pin.
