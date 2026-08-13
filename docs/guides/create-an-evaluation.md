# Creating an evaluation

**Who this is for:** the procurement specialist reading a tender — deciding whose
response is whose, and what needs to be compared across them.

This is the guide to the **New evaluation** screen. It takes a corpus that has
already been run through the engine and says two things about it: whose response
is whose, and **what you want answered**. Those questions are what an assistant
then uses to build you a report — a written document, grounded in the actual
words of the responses, that you can hand to a delegate.

It does not upload or process documents. If nobody has run them yet, that is
[Creating a corpus](./create-a-corpus.md) first — different job, different
screen, usually a different person.

> **Status.** The screen described here exists and works. What is still being
> built is the step after it: today, creating the evaluation records who and
> what, but the passes that read the corpus against your fields still have to be
> run separately. See
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
and an annexure from the same bidder. The brand is how the report and every
view over it delineate one response from another.

Rules worth knowing before you meet them as errors:

- **Every included document needs a brand.** A blank one is refused.
- **A document belongs to exactly one brand.**
- **Two brands must stay distinguishable.** Brand names become ids, so "Acme Pty
  Ltd" and "acme-pty-ltd" collapse to the same thing and the create is refused.
- **Switching corpus clears your choices** — a document id only means anything
  inside its own corpus.

## 3. Say what you want answered

The fields are the point of the whole screen. Each one is a question you want
answered about every response — and they are not just columns in a table. They
are what directs the assistant that writes your report: it does not roam the
corpus looking for something to say, it is pointed at the passages that were
placed against your fields, and it builds the report from those.

A field is a **name** and a **definition**, and the definition carries the weight.
It is what the system reasons from when deciding whether a passage in a response
actually addresses that field. Write it the way you would explain the field to a
colleague who has not seen the tender:

| Name | Definition |
|---|---|
| Warranty | The warranty period offered and what it covers. |
| Lead time | How long from order to delivery on site, in weeks. |
| Compliance | Whether the response states compliance with AS/NZS 4020. |

A vague definition gets vague results. "Warranty" on its own leaves the system
guessing what counts; "the warranty period offered and what it covers" does not.

Use **Add another field** for as many as you need. At least one field with *both*
halves filled in is required; a half-filled field is ignored rather than
rejected. Two fields cannot share a name.

**What you ask for is what you get back.** A field nothing in the corpus
addresses comes back saying so, rather than being quietly dropped or filled in
from the model's general knowledge. That is deliberate — a gap you can see is
worth more than a paragraph that reads well and is not grounded in anything.

**Nothing here is a rule or a keyword.** There is no pattern to author on this
screen, so every field is resolved by reading rather than by matching.

### What the report is, and what it is not

Worth knowing before you write your fields, because it shapes what a good field
looks like. This is the design the report is being built to — see
[What happens next](#what-happens-next) for how much of it you can reach today:

- **Every load-bearing claim is the response's own words.** A passage in the
  report is copied from the source exactly — not paraphrased, not tidied — and
  carries a citation back to the place it came from, so you can open the source
  and see it. The connective prose around those passages is the assistant's;
  the facts are not.
- **Financial figures arrive as written**, with their currency and qualifiers
  intact. Nothing is totalled, converted or aligned on the way.
- **It says what it could not find.** A section it cannot ground in the corpus is
  reported as unreachable, naming what was missing.
- **It is a draft, and you are the author.** Before you send it anywhere you can
  reorder sections, rewrite the connective prose, and remove passages or whole
  sections. What you cannot do is silently edit a quoted passage — that would
  break the link back to the source, so a passage is either kept as it stands or
  removed along with its citation.
- **It does not score or recommend.** redline does not rank the responses or
  decide the tender. It shows you what each one says, with the receipts.

## 4. Create

**Create evaluation** stays disabled until a corpus is chosen, the evaluation has
a name, at least one document is included, every included document has a brand,
and at least one field has both halves.

Creating it records the structure and then reads the corpus against it: the
documents are loaded, grouped by brand, and every one of them is read against
your fields, with each finding anchored to the passage it came from. That takes a
while — it is model work over every document — and those anchored findings are
what the report assembler is later pointed at.

If the reading fails, the evaluation still exists with its brands and fields
intact; the failure says so plainly and can be retried without composing it
again.

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

**The report is the point, and it is assembled outside these screens.** redline
does not render a report. It exposes the evaluation to Wayfinder as a set of
tools — the "Redline report tools" server — which fetch passages by provenance,
fetch financial expressions as written, and walk the entity graph. Wayfinder's
assembler drives those tools: it is pointed at the findings your fields produced,
transfers the passages, and writes the connective prose around them.

> **Not yet reachable.** The pieces exist — the tool server, and an assembly loop
> in Wayfinder's adapters that drives it — but nothing is wired to a screen or a
> flow, and the tool server is registered by a setup script rather than being
> there by default. There is no button that produces a report today, and the
> editing-before-export behaviour described above is the design it is being built
> to, not something you can do. Everything on this page up to and including
> **Create** is real; the report is not yet.

The redline screens are supporting views over the same data:

- **review** — the grid of brands against fields,
- **pivots** — the pricing pivots,
- **grouping** — how documents are grouped into responses,
- **documents/{documentId}** — one document as extracted, for checking a citation
  against its source.

## What the deployed build still does

Creating an evaluation currently records the brands, fields and grouping, and
then stops. The passes that read the corpus against your fields — loading the
documents, placing their content against each field, building the table — are not
yet run from this screen; they only run from a terminal script. So the create
lands you on the evaluation's grouping view, and until someone runs those passes
the review grid and pivots are empty and the report tools have nothing to be
pointed at.

The delivery plan tracks this as the last step of the Create Corpus programme.
