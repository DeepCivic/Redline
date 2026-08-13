# Creating an evaluation

**Who this is for:** the procurement specialist reading a tender — deciding whose
response is whose, and what needs to be compared across them.

This is the guide to the **New evaluation** screen. It takes a corpus that has
already been run through the engine and turns it into something you can read: who
responded, and what each response says about the things you care about.

It does not upload or process documents. If nobody has run them yet, that is
[Creating a corpus](./create-a-corpus.md) first — different job, different
screen, usually a different person.

> **Status.** The screen described here exists and works. What is still being
> built is the last step: today, creating the evaluation records who and what,
> but the reading passes that fill the grid still have to be run separately. See
> [What the deployed build still does](#what-the-deployed-build-still-does).

The screen is served by the forked Wayfinder, not by a standalone redline app.
See [Running both stacks locally](./two-stack-local-run.md) for how to get it up.

---

## Before you start

- **You need the `evaluation:create` permission** (admins hold it through the
  admin wildcard). Without it the route is not served and the **New evaluation**
  button does not appear — you will still see the Evaluations index if you hold
  `evaluation:review`, but not the way to start one.
- **The corpus must already have been run.** Only corpora the engine has
  extracted appear in the picker.

## Getting there

**Evaluations** in the sidebar, then **New evaluation**.

---

## 1. Choose the corpus

The **Corpus** dropdown lists every corpus the engine has extracted, by the name
it was run under, with its document count. Pick the one you want to evaluate.

That name is also the evaluation's id — a corpus and the evaluation over it are
the same thing under two names, which is why you pick from the list rather than
typing. One evaluation per corpus: a corpus already claimed is one that already
has an evaluation, so open it from the index instead.

If the list is empty, nothing has been run yet — start with
[Creating a corpus](./create-a-corpus.md).

**Evaluation name** is what you and your colleagues will recognise the tender by
on the index — "Water treatment panel 2026".

## 2. Say which brand each response belongs to

Once a corpus is chosen, its documents are listed. Each row shows:

- a checkbox to include the document,
- the document's opening passage — the document's own id is a content hash and
  tells a human nothing, so the preview is how you tell one response from
  another,
- its id and chunk count,
- a **Brand** box, which stays disabled until you tick the document.

Tick every document you want evaluated and type the responding brand against each
one. Several documents commonly share a brand — a submission, a pricing schedule
and an annexure from the same bidder. The brand is what the review grid
delineates by.

Rules worth knowing before you meet them as errors:

- **Every included document needs a brand.** A blank one is refused.
- **A document belongs to exactly one brand.**
- **Two brands must stay distinguishable.** Brand names become ids, so "Acme Pty
  Ltd" and "acme-pty-ltd" collapse to the same thing and the create is refused.
- **Switching corpus clears your choices** — a document id only means anything
  inside its own corpus.

## 3. Name the fields the responses are read against

Each field becomes a column in the review grid. A field is a **name** and a
**definition**, and the definition matters more: it is what the adjudicator
reasons from when deciding what a response says about that field.

Write it the way you would explain the field to a colleague who has not seen the
tender:

| Name | Definition |
|---|---|
| Warranty | The warranty period offered and what it covers. |
| Lead time | How long from order to delivery on site, in weeks. |
| Compliance | Whether the response states compliance with AS/NZS 4020. |

Use **Add another field** for as many as you need. At least one field with *both*
halves filled in is required; a half-filled field is ignored rather than
rejected. Two fields cannot share a name.

Fields become the evaluation's comprehension lens. No hard rules are created
here — there is nowhere to author a pattern on this screen, so **every field goes
to adjudication**.

## 4. Create

**Create evaluation** stays disabled until a corpus is chosen, the evaluation has
a name, at least one document is included, every included document has a brand,
and at least one field has both halves.

Creating it records the structure and then reads the corpus against it: the
documents are loaded, grouped by brand, classified against your fields, and the
review table is built. That takes a while — it is model work over every document
— and when it finishes you land on the evaluation with a populated grid.

If the reading passes fail, the evaluation still exists with its brands and
fields intact; the failure says so plainly and can be retried without composing
it again.

Nothing is written until everything validates, so a rejected create leaves no
half-composed evaluation behind.

---

## When it refuses

Errors appear above the buttons, in the engine's own words:

| Message | What it means |
|---|---|
| `an evaluation already exists over corpus …` | The corpus is claimed. Open the existing one from the index. |
| `document … is not staged under corpus …` | The document is not in that corpus's set. Usually a stale form; reload and pick again. |
| `document … has no brand` | An included document was left without a brand. |
| `document … is assigned to more than one brand` | The same document was included twice. |
| `field … is declared more than once` | Two fields share a name. |
| `brand … is indistinguishable from another brand once identified` | Two brand names reduce to the same id. |
| `an evaluation needs at least one document` | Nothing was ticked. |
| `an evaluation needs at least one field to read responses against` | No field has both halves filled in. |

## What happens next

From the evaluation you can reach:

- **review** — the grid of brands against fields,
- **pivots** — the pricing pivots,
- **grouping** — how documents are grouped into responses,
- **documents/{documentId}** — one document as extracted.

---

## What the deployed build still does

Creating an evaluation currently records the brands, fields and grouping, and
then stops. The passes that read the corpus — loading the documents, classifying
them against your fields, building the table — are not yet run from this screen;
they only run from a terminal script. So the create lands you on the evaluation's
grouping view, and the review grid and pivots are empty until someone runs those
passes separately.

The delivery plan tracks this as the last step of the Create Corpus programme.
