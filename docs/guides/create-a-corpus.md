# Creating a corpus and firing its run

**Who this is for:** whoever starts a tender off — the person holding the
documents, deciding what the engine should do with them, and watching the run.

This is the guide to the **Create Corpus** screen (`/create-corpus`). It is the
start surface: it composes the evaluation *and* fires the womblex run that
extracts, chunks, embeds and reads the documents, then tracks that run to a
finish. When the run lands, the evaluation is ready to group and review.

If the corpus has already been run and you only need to compose an evaluation
over it, use [Creating an evaluation](./create-an-evaluation.md) — the same form
without the run.

The screen is served by the forked Wayfinder, not by a standalone redline app.
See [Running both stacks locally](./two-stack-local-run.md) for how to get it up.

---

## Before you start

- **You need the `evaluation:create` permission** (admins hold it through the
  admin wildcard). Without it the sidebar entry is hidden and the route is not
  served.
- **The ingest sidecar must have its run trigger configured.** It needs a
  database DSN and a store URI; without them the run endpoints answer *"run
  trigger is not configured"* and nothing can be fired. Check
  `curl -s localhost:8000/health` before blaming the form.
- **Check which womblex lane you are on.** `"womblexMode":"real"` on that same
  health response means real extraction. `"stub"` is a dependency-free test
  double that serves deterministic *fabricated* documents — a run left on it
  looks like it succeeded while showing invented content.
- **A corpus must already be staged.** The picker lists corpora that already
  have content in redline's store, so browsing raw uploaded files is not
  something this screen does yet — see [Staging documents](#staging-documents)
  below.

## Getting there

**Create Corpus** in the sidebar. The heading reads *Create corpus*.

---

## 1. Choose the corpus and name the evaluation

The **Corpus** dropdown lists staged corpora as `corpus-id — N documents`.

You cannot type a corpus id. **The corpus id becomes the evaluation's id** — the
same string addresses the corpus in object storage, in redline's chunk store and
at the sidecar, so a mistyped one would produce an evaluation whose documents
can never be read.

If you see *"No corpus has been staged yet. An operator stages one over object
storage before a run can be fired over it"*, there is nothing to run against.

**Evaluation name** is the human label for the tender — "Water treatment panel
2026".

### Staging documents

Uploading from the browser is not wired up yet. The write seam exists — bytes
land under `proc/{evaluationId}/inputs/` in redline's bucket, which is where the
womblex runner resolves its input from — but this screen does not drive it, and
the picker reads from the store rather than the raw bucket. In practice that
means an operator puts the documents in place and runs an initial extraction
(`POST /ingest` against the sidecar) before the corpus turns up here.

## 2. Documents, brands and fields

These three sections behave exactly as they do on the New evaluation screen, and
the same rules apply:

- **Documents and brands** — tick the documents to include and type the
  responding brand against each. The preview is shown because the document id is
  a content hash and tells you nothing. Every included document needs a brand;
  no document may carry two; two brand names must not slug to the same id.
- **Fields** — a name and a definition per field, at least one complete pair.
  The definition is what the adjudicator reasons from, so write it as you would
  explain the field to a colleague.

[Creating an evaluation](./create-an-evaluation.md) covers both in full,
including what makes a good field definition and every rejection message.

Switching corpus clears the document choices made against the previous one.

## 3. Choose the stages to run

**Stages to run** is the downstream sequence the engine runs after extraction:

| Stage | What it does |
|---|---|
| Chunk | Splits the extracted documents into chunks. |
| Embed | Produces the vectors retrieval reads by. |
| Enrich | Runs the entity/graph enrichment pass. |
| Money | Finds and types the amounts the pricing pivots are built from. |

All four are ticked by default, which matches the sequence the corpus profile
ships. Leave it alone unless you have a reason.

The **order** is not yours to author: the sidecar normalises the sequence and
enforces the dependencies (chunk before embed) below the seam. Unticking a stage
removes it; it never reorders the rest. Only these four are offered — the
structural stages are not run parameters and the sidecar refuses them.

## 4. Advanced run config (optional)

The allow-listed slice of the engine config. **Leave a group switched off and
the run inherits the corpus profile default** — the editors only appear once you
tick the group, so touching nothing runs the profile as it ships.

**Override chunk mode**

- *Chunk size (tokens)* — must be a whole positive number. Defaults to 480.
- *Chunk tables* — whether tables are chunked. On by default.

**Override money vocabulary**

- *Default currency (ISO 4217)* — the currency a bare number inherits when its
  column or prose declares none. Three letters; AUD by default.
- *Extra header terms* — comma-separated tender-schedule header terms the
  built-in money vocabulary misses.
- *Extra veto terms* — comma-separated terms that suppress a header which
  collides with a built-in money term without actually being money.

Terms are lower-cased and de-duplicated for you; a blank term or a currency that
is not three letters is refused before the run is fired.

What is **not** here cannot be reached from this screen at all: the embed model
and task, the OCR engine, whether enrichment is enabled, and the structural
keys all stay fixed in the file.

> **Known limitation.** The stage sequence takes effect, but the chunk-mode and
> money-vocabulary overrides currently do not. They are validated in the browser
> and sent to the ingest sidecar, but the sidecar's run request accepts only the
> evaluation id and the stage sequence, so the override is dropped and the run
> uses the file default. Change `redline.yaml` if you need a different chunk size
> or money vocabulary today.

## 5. Start the run

**Start run** stays disabled until the form can actually fire one. The button
label tells you what is missing:

| Label | Meaning |
|---|---|
| *Choose a corpus, a document and a name to start* | One of those three is missing. |
| *Select at least one stage to run* | Every stage was unticked. |
| *Start run* | Ready. |

It also stays disabled while an included document has no brand and while no
field has both halves filled in. Once clicked it reads *Starting…* until the
evaluation is created and the run is queued.

Clicking it creates the evaluation first, then fires the run. The evaluation is
created before anything is queued, so a rejected create — a corpus that is
already claimed, a blank brand — stops there without leaving a run firing over
an evaluation that does not exist.

## 6. Watch the run

The form is replaced by the run tracker, which polls every couple of seconds
until the run settles. A real run takes minutes.

| What you see | State |
|---|---|
| *Extracting documents* | The engine is extracting; the tracker shows **Running…** |
| *Running stages* | Extraction is done and the downstream sequence is going. |
| *Completed: chunk · embed* | The stages finished so far, in run order. |
| *Run complete* + **Open the evaluation** | Done. The link takes you to the evaluation's grouping view. |
| *&lt;Stage&gt; stage failed* + the engine's message | The named pass failed. |

**A failed run is never a dead end.** An errored run names the stage that failed
and offers **Resume run**. Resuming re-fires the same run rather than starting a
new one: the engine's enqueue is idempotent and completed stages skip on their
published outputs, so it picks up where it stopped. It is safe to press more
than once.

The tracker stops polling once the run settles, so a failed run will not spin
forever waiting for something that is not coming.

## What happens next

Follow **Open the evaluation** to `/evaluations/{id}/grouping`. From there:

- **grouping** — how documents are grouped into responses,
- **review** — the grid of brands against fields,
- **pivots** — the pricing pivots the money stage feeds,
- **documents/{documentId}** — one document as extracted.

The evaluation is also on the Evaluations index by name.
