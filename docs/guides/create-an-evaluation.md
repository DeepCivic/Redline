# Creating an evaluation

**Who this is for:** the procurement specialist who has been told a corpus is
ready and wants to start reading it.

This is the guide to the **New evaluation** screen (`/evaluations/new`). It
composes an evaluation over a corpus that has *already been extracted* — it does
not upload anything and it does not run the engine. If the corpus has not been
run yet, use [Creating a corpus](./create-a-corpus.md) instead: that screen does
everything this one does and fires the run as well.

The screen is served by the forked Wayfinder, not by a standalone redline app.
See [Running both stacks locally](./two-stack-local-run.md) for how to get it up.

---

## Before you start

- **You need the `evaluation:create` permission** (admins hold it through the
  admin wildcard). Without it the route is not served and the **New evaluation**
  button does not appear — you will still see the Evaluations index if you hold
  `evaluation:review`, but not the way to start one.
- **The corpus must already be staged.** "Staged" here means the ingest sidecar
  has extracted the documents and loaded their chunks into redline's store. A
  corpus that has been uploaded but never run does not appear in the picker.

## Getting there

Open **Evaluations** in the sidebar, then **New evaluation**. The heading reads
*New evaluation*.

---

## 1. Choose the corpus

The **Corpus** dropdown lists every corpus with staged content, as
`corpus-id · N documents`. Pick one.

You cannot type a corpus id, and this is deliberate. **The corpus id becomes the
evaluation's id** — the same string addresses the corpus in object storage, in
redline's chunk store, and at the ingest sidecar. A retyped id that does not
match produces an evaluation whose documents can never be read, and nothing
fails until classification quietly returns nothing.

If the dropdown is replaced by *"No corpus has been staged yet. An operator
stages and extracts one before an evaluation can be created over it"*, there is
nothing to evaluate yet. That is a state, not an error.

**Evaluation name** is what you and your colleagues will recognise the tender by
on the index — "Water treatment panel 2026", not the corpus id.

## 2. Say which brand each response belongs to

Once a corpus is chosen, the **Documents and brands** section lists its
documents. Each row shows:

- a checkbox to include the document in the evaluation,
- the document's opening passage (about 200 characters) — the `documentId` is
  womblex's `source_hash`, which tells a human nothing, so the preview is how
  you tell one tender response from another,
- the document id and its chunk count,
- a **Brand** box, which stays disabled until you tick the document.

Tick every document you want evaluated and type the responding brand against
each one. Several documents may carry the same brand — that is the normal case
for a response split across a submission, a pricing schedule and an annexure.
The brand is what the review grid delineates by.

Rules worth knowing before you get an error:

- **Every included document needs a brand.** A blank one is refused.
- **A document belongs to exactly one brand.** The same document cannot be
  assigned twice.
- **Two brands must stay distinguishable once identified.** Brand names are
  slugged into ids, so "Acme Pty Ltd" and "acme-pty-ltd" collapse to the same
  thing and the create is refused. Give them names that differ in more than
  punctuation.
- **Switching corpus clears your choices.** A document id only means anything
  inside its own corpus.

## 3. Name the fields the responses are read against

Each field becomes a column in the review grid. A field is a **name** and a
**definition**, and the definition matters more than the name: it is what the
adjudicator reasons from when it decides what a response says about that field.

Write the definition the way you would explain the field to a colleague who has
not seen the tender:

| Name | Definition |
|---|---|
| Warranty | The warranty period offered and what it covers. |
| Lead time | How long from order to delivery on site, in weeks. |
| Compliance | Whether the response states compliance with AS/NZS 4020. |

Use **Add another field** for as many as you need. At least one field with
*both* a name and a definition is required — a field with only one half filled
in is ignored rather than rejected.

Two fields cannot share a name (they slug to the same topic id and the create is
refused).

Fields become the evaluation's comprehension lens. No hard rules are created
here — there is nowhere to author a pattern on this screen, so **every field
goes to adjudication**.

## 4. Create

**Create evaluation** stays disabled until all of the following hold:

- a corpus is chosen,
- the evaluation has a name,
- at least one document is included,
- every included document has a brand,
- at least one field has both a name and a definition.

On success you land on the evaluation's **grouping** view
(`/evaluations/{id}/grouping`) — the evaluation has documents but no
classifications yet, so there is no review grid to send you to. The new
evaluation also appears on the Evaluations index.

Nothing is written until everything validates, so a rejected create leaves no
half-composed evaluation behind for you to trip over on the retry.

---

## When it refuses

Errors appear above the buttons, in the engine's own words. The ones you are
most likely to meet:

| Message | What it means |
|---|---|
| `an evaluation already exists over corpus …` | The corpus is claimed. One evaluation per corpus — open the existing one from the index. |
| `document … is not staged under corpus …` | The document is not in that corpus's staged set. Usually a stale form after the corpus changed; reload and pick again. |
| `document … has no brand` | An included document was left without a brand. |
| `document … is assigned to more than one brand` | The same document was included twice. |
| `field … is declared more than once` | Two fields share a name. |
| `brand … is indistinguishable from another brand once identified` | Two brand names slug to the same id. |
| `an evaluation needs at least one document` | Nothing was ticked. |
| `an evaluation needs at least one field to read responses against` | No field has both halves filled in. |

## What happens next

The evaluation is created and readable, but nothing has been classified. From
`/evaluations/{id}` you can reach:

- **grouping** — how documents are grouped into responses,
- **review** — the grid of brands against fields, once classification has run,
- **pivots** — the pricing pivots,
- **documents/{documentId}** — one document as extracted.
