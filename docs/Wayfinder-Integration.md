# Wayfinder integration — the contract

> What Wayfinder builds against, and what it owns that redline deliberately does not.
> Written from redline's side: this repo cannot implement the Wayfinder half, so it
> specifies it instead.

Redline is a read-only MCP server. Everything user-facing — the chat, the schema
form, the assembled report, the export — belongs to Wayfinder. This document is the
seam between them.

---

## 1. The journey

A worked example, using a tender assessment. Ownership is marked on every step.

| # | Step | Owner |
|---|---|---|
| 1 | An administrator builds the flow on Wayfinder's canvas. Redline is registered once for the deployment as an available tool surface; flow authors do not configure it per flow | Wayfinder |
| 2 | A specialist stages the corpus and Womblex processes it | Womblex |
| 3 | A user starts a session and works the flow in chat, gathering context conversationally | Wayfinder |
| 4 | The flow reaches the step chat cannot do: the same twenty facts from each of fifty documents | — |
| 5 | The AI needs a report schema, so the chat renders a **schema-definition form**; the human names and describes each column | **Wayfinder — new, §3** |
| 6 | The AI discovers what the documents actually contain, using `get_schema` against real extracted tables | redline serves; Wayfinder's agent calls |
| 7 | The AI assembles the report iteratively, fetching exact source with `get_verbatim_data` and citing the chunk each value came from | redline serves; Wayfinder's agent calls |
| 8 | The AI's output is checked against the bytes redline returned, and anything that fails is flagged rather than corrected | **Wayfinder — §4** |
| 9 | The user reads the results table and exports it to **CSV** | **Wayfinder — new, §5** |
| 10 | The table goes back into the flow, where Wayfinder drafts the assessment document | Wayfinder |

**What this gains over chat alone:** fifty documents answered consistently against the
same twenty questions; every accepted value traceable to a verbatim quote; and every
unverifiable value visibly flagged rather than quietly guessed.

---

## 2. Registering redline

Redline is a long-running service addressed by URL — not a process Wayfinder spawns.
Wayfinder's MCP client speaks SSE and streamable HTTP only, so:

| Setting | Value |
|---|---|
| Transport | `streamable-http` |
| URL | `http://redline-mcp:8930/mcp` (see `infra/docker-compose.yml`) |
| `communicatesExternally` | **`false`** |

`communicatesExternally: false` is load-bearing and not a judgement about
sensitivity. The flag classifies whether a server talks *outside* Wayfinder; redline
reads object storage inside the same deployment and sends nothing anywhere. That it
reads commercial-in-confidence documents is a confidentiality concern about the data,
not about egress. Asserting `true` would register the server but make it **not
selectable in flows**, which makes the report assembler unbuildable.

Redline is stateless and opens no session: a fresh client per call, closed after, is
exactly the traffic shape it is built for.

---

## 3. AI-driven form fields (new)

The chat UI detects when the agent needs a report schema and renders a dynamic form
instead of asking for it in prose.

**Why a form and not a conversation.** A column definition has structure — a name, a
description, and optionally a constraint — and prose round-trips lose one of the three
about as often as not. A form makes the schema a typed object the agent can act on
directly.

### What the form collects, per column

| Field | Required | Notes |
|---|---|---|
| Name | yes | The column header in the final report |
| Semantic description | yes | Plain English: what fact this column holds. This is what the agent matches against document content |
| Constraint | no | `financial` or `date`. Regex and enum are deferred |

### Where redline helps

Before the form is filled, the agent can ground it in what the documents actually
contain rather than in what the user imagines they contain:

- `list_documents` — what is in this run at all
- `get_schema` at table scope — the **exact header row** of a specific extracted
  table, verbatim. This is what lets a suggested column use the words the document
  uses
- `get_schema` at graph scope — the entity labels and relation names present, so the
  agent can offer columns the corpus can actually answer

The form is Wayfinder's to render and validate. Redline supplies the vocabulary.

---

## 4. Assembling without hallucinating

Redline guarantees the bytes it returns are Womblex's. It cannot guarantee what the
agent does with them. **These checks are Wayfinder's, applied mechanically to the
agent's output, on every value.** They are not manual review steps.

**A value for a column that was not asked for is rejected outright.** Not flagged —
rejected. It never reaches the report.

**Evidence citing a passage no tool returned in this call is rejected outright.**
This is the check that catches a plausible-sounding citation to a page that was never
opened.

**A quote that is not a contiguous substring of the cited chunk is flagged, never
corrected.** Check it against the actual bytes redline returned. If it does not match:
mark the value for review, keep the original quote, and do not rewrite, tidy or
re-word it to make it match. *A quietly reworded quote no longer resolves to its
source, and resolving a quote to its source is the entire product.*

**A value with no evidence at all is flagged**, not accepted as verified.

### Statuses

| Status | Means |
|---|---|
| `verified` | at least one citation passed the substring check and, if constrained, normalised cleanly |
| `missing` | the agent returned nothing and said why |
| `needs_review` | evidence failed, normalisation failed, or a value arrived with no evidence |

Only `verified` values reach the final report. `missing` and `needs_review` values are
held back but stay **visible in the export** — a blank cell and a withheld cell must
never look the same. There is no in-app approval workflow: the export is the review
surface, and resolving a flagged value happens outside the product.

### Money and dates

**Money is already normalised. Re-normalising it corrupts it.** Where evidence anchors
to a Womblex money span, use the span's `value`: an exact `decimal128(38,4)` with
**sign and multiplier already folded in**. `multiplier` and `negative` are an audit
trail of how the amount was read, not arithmetic to redo — multiplying by the
multiplier or re-applying the sign double-counts. `currency` may be unresolved.
`modifier` ("up to", "approximately") is deliberately *not* folded in, so a bounded
amount is not an exact one, and `range_group`/`range_role` link two rows that are one
amount's endpoints.

Fall back to parsing a raw string only where no span anchors, and then through **one**
shared parser that preserves sign, disambiguates separators, and **refuses genuinely
ambiguous digit groupings rather than guessing**. This is measured, not theoretical: a
parser stripping everything outside `[0-9.]` turned `$1.234,56` into `1.23456`,
`$1 234,50` into `123450.0`, `-$500.00` into `500.0` and `($1,234.56)` into `1234.56`
— a credit summed as a debit. Two independent parsers is how that happened. Do not
build a second one.

Dates: ISO 8601 out, Australian day-first default, ambiguous → `needs_review`.

Any normalisation failure yields `needs_review` with the raw value preserved beside it.

---

## 5. CSV export (new)

A dedicated action exporting the assembled report to `.csv`.

- One row per document, one column per field
- Flagged values are **visible**, with their reason — never blank, never silently
  omitted
- The export is the review surface, so it must carry enough to chase a flagged value
  down: the document, the column, the raw value and why it was held back

---

## 6. What redline will not do for you

Asking for any of these is a boundary error, not a missing feature:

- Summarise, paraphrase, infer, or fill a gap
- Rank chunks by similarity — Womblex writes embeddings but ships no index, so
  nothing ranks them. Work from ids and anchors, or traverse the graph
- Remember anything between calls
- Normalise, total, convert or reconcile money
- Decide what a value means

**The graph locates; it never sources.** `graph_find_entities`, `graph_edges_from`
and `graph_edges_to` point at the chunk an entity was found in. A graph edge is a
navigation pointer, not evidence: a value found by traversal still cites its chunk and
still passes the substring check in §4.

---

## 7. Open questions

1. **What is a `corpusId`, to Wayfinder?** Redline takes it on trust. Whether it is a
   Wayfinder identifier or a Womblex one needs settling with this work.
2. **Does the handoff at step 10 stay manual?** In v1 the table reaches the rest of
   the flow as a file the user moves. Whether it should become an automated pass-back
   is open.
3. **Who picks the run?** Redline exposes `list_runs` and requires an explicit run.
   Whether Wayfinder pins one per report or always takes the latest is Wayfinder's
   call, but it must be a call — not a default that drifts between reads.
