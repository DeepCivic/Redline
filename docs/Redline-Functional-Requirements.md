# Redline — Functional Requirements

**Status:** Draft for review
**Date:** 2026-08-20
**Audience:** Business and product reviewers
**Source of truth:** [`docs/Redline-Plan.md`](./Redline-Plan.md) — this document restates
that plan's behaviour as testable requirements. Where the two disagree, the plan wins and
this document is corrected.

---

## 1. Purpose

Redline turns a pile of documents into a **table**. A user describes the columns they
want in plain English, points Redline at a set of documents, and gets back one row per
document with each column filled in — or explicitly flagged as unfilled.

The product's core promise is not "the answer". It is **"this answer, and here is the
exact sentence it came from"**. Every requirement below exists to protect that promise:
a value that cannot be traced back to a verbatim quote in a source document is never
presented as a result.

## 2. Scope

### In scope for v1

| Capability | Summary |
| --- | --- |
| Report definition | The user defines the columns of the report they want |
| Document selection | The user chooses which documents in a corpus the report covers |
| Extraction run | Redline reads each document once and fills in every column for it |
| Evidence verification | Every value is checked back against the source text |
| Normalisation | Money and date values are converted to a consistent form |
| Status and flagging | Every cell is marked verified, missing, or needs review |
| Export | The completed report leaves the product as CSV and XLSX |

### Explicitly out of scope for v1

These are recorded so reviewers do not assume them. Each is a decision, not an omission.

| Not included | Why |
| --- | --- |
| In-app approval or sign-off workflow | The export is the review surface; a flagged value is resolved outside the product |
| Editing extracted values in the product | The results table is read-only |
| Automatic summary writing | No narrative generation of any kind |
| Similarity or keyword search across the corpus | v1 points the extractor at specific documents and sections; it does not let it go looking. To be revisited only when a measurement shows pointing misses fields a human finds |
| Free-text pattern and pick-list constraints | Only money and date constraints are supported in v1 |
| Judgement, scoring or rating of documents | Redline reports what the documents say; it does not assess them |

## 3. Glossary

| Term | Meaning |
| --- | --- |
| **Corpus** | A collection of documents that has been prepared for reading |
| **Document** | One source file within a corpus (for example, a single PDF) |
| **Report definition** | The set of columns a user has described |
| **Column** | One field the user wants extracted, with a name and a plain-English description |
| **Run** | One execution of a report definition over a chosen set of documents |
| **Row** | The results for one document — exactly one row per document per run |
| **Value** | One cell: the content extracted for one column of one row |
| **Evidence** | The document, the specific passage, and the exact quoted text a value came from |
| **Money span** | A monetary amount that document preparation has already identified and resolved, including its currency and sign |
| **Flagged** | A value held back from the final report because it is missing or needs review |

---

## 4. Functional requirements

Each requirement is written as **Given / When / Then**. "The user" means a business user
operating the product; "the system" means Redline.

### 4.1 Defining the report

---

**FR-1.1 — A column is defined by a name and a plain-English description**

> **Given** a user is creating a report definition
> **When** they add a column, supplying a name and a description of what it means
> **Then** the system accepts the column and includes it in the definition
> **And** the description is what the system uses to decide what to extract — no
> technical query language is required of the user.

---

**FR-1.2 — A column may optionally be constrained to money or to a date**

> **Given** a user is defining a column
> **When** they mark it as a money column or a date column
> **Then** the system records that constraint against the column
> **And** values extracted for that column will be normalised to a consistent form
> (see FR-5.1 to FR-5.5).

---

**FR-1.3 — A column with no constraint is extracted as free text**

> **Given** a column has been defined with no constraint
> **When** the system extracts a value for it
> **Then** the value is captured as the document states it, with no reformatting.

---

**FR-1.4 — Only money and date constraints are offered in v1**

> **Given** a user is choosing a constraint for a column
> **When** they open the list of available constraint types
> **Then** only "money" and "date" are offered
> **And** pattern-matching and pick-list constraints are not presented as options.

---

### 4.2 Selecting documents and starting a run

---

**FR-2.1 — A user chooses which documents a run covers**

> **Given** a corpus has been prepared and a report definition exists
> **When** the user opens the document picker
> **Then** the documents available in that corpus are listed
> **And** the user can select any subset of them for the run.

---

**FR-2.2 — Starting a run produces exactly one row per selected document**

> **Given** a user has selected five documents and a report definition with four columns
> **When** they start the run
> **Then** the run produces exactly five rows
> **And** each row carries exactly four values — one per defined column
> **And** no document produces two rows, and no two documents share a row.

---

**FR-2.3 — A run reports its progress and its outcome**

> **Given** a run has been started
> **When** the user views the run
> **Then** its state is shown as one of: pending, running, complete, or failed
> **And** the user can see progress as documents are completed rather than waiting
> with no indication until the end.

---

**FR-2.4 — A document is read from one specific preparation run only**

> **Given** a corpus has been prepared more than once, so more than one set of prepared
> output exists for the same documents
> **When** a report run reads that corpus
> **Then** it reads from exactly one named preparation run
> **And** each document is served exactly once
> **And** no value is built from two copies of the same document merged together.
>
> *Business rationale: a silently doubled document produces doubled evidence and
> plausible-looking wrong numbers. No report row is trustworthy until this holds.*

---

### 4.3 Extracting values

---

**FR-3.1 — Each document is read in a single extraction pass covering all columns**

> **Given** a report definition with twenty columns and a run over fifty documents
> **When** the run executes
> **Then** the system performs one extraction pass per document — fifty in total, not
> one thousand
> **And** all twenty columns are answered within that single pass.
>
> *Business rationale: cost scales with the number of documents, not with documents
> multiplied by columns.*

---

**FR-3.2 — Every extracted value is returned with its supporting evidence**

> **Given** the system has extracted a value for a column
> **When** it returns that value
> **Then** it also returns the document it came from, the specific passage, and the
> exact text quoted from that passage.

---

**FR-3.3 — Values are copied from the source, not composed**

> **Given** a relevant passage exists in a document
> **When** the system extracts a value from it
> **Then** the value reflects what the passage states
> **And** the original text as extracted is retained unchanged alongside any
> normalised form (see FR-5.6).

---

**FR-3.4 — Relationship lookups may locate a passage but can never be the evidence**

> **Given** the system uses the document's mapped entities and relationships to find
> where a named organisation or party is discussed
> **When** it then extracts a value based on what it found
> **Then** the value still cites a specific passage of document text as its evidence
> **And** a relationship on its own is never accepted as the source of a value.
>
> *Business rationale: relationships are a way of navigating to the right page. The
> claim being made to the reader is always "the document says this", never "our
> internal map implies this".*

---

**FR-3.5 — When nothing is found, the system says so and says why**

> **Given** a document contains no information answering a defined column
> **When** the run processes that document
> **Then** the value for that column is marked **missing**
> **And** a reason is recorded explaining that nothing was found
> **And** the cell is not left silently blank without explanation.

---

### 4.4 Trust rules — what the system refuses to accept

These four rules are applied by the system to its own extraction output, automatically
and mechanically, on every value. They are not manual review steps.

---

**FR-4.1 — A value for a column that was not asked for is rejected**

> **Given** a report definition with the columns "Contract value" and "Start date"
> **When** the extraction returns a value for a column called "Vendor name"
> **Then** that value is rejected outright and never appears in the report.

---

**FR-4.2 — Evidence pointing at a passage the system did not actually read is rejected**

> **Given** the extraction cites a passage identifier as its evidence
> **When** that passage was not among the document content read during this extraction
> **Then** the value is rejected outright and never appears in the report.
>
> *Business rationale: this is the check that catches a plausible-sounding citation
> to a page that was never opened.*

---

**FR-4.3 — A quote that is not word-for-word in the source is flagged, never corrected**

> **Given** a value is returned with a quotation as its evidence
> **When** the system checks that quotation against the actual bytes of the cited
> passage and finds it is not an exact, contiguous match
> **Then** the value is marked **needs review**
> **And** the value is not silently dropped
> **And** the quotation is not rewritten, tidied, or re-worded to make it match.
>
> *Business rationale: a quietly reworded quote no longer resolves to its source. Being
> able to resolve a quote to its source is the entire product.*

---

**FR-4.4 — A value with no evidence at all is flagged**

> **Given** a value is returned with no supporting evidence
> **When** the system assigns its status
> **Then** the value is marked **needs review** rather than accepted as verified.

---

### 4.5 Money and date normalisation

---

**FR-5.1 — Money uses the already-resolved amount in preference to re-reading the text**

> **Given** a column is constrained to money
> **And** the cited evidence corresponds to an amount that document preparation has
> already identified and resolved
> **When** the system normalises the value
> **Then** it uses that already-resolved amount, including its currency and its sign
> **And** it does not re-parse the surrounding text to arrive at a number.

---

**FR-5.2 — An already-resolved amount is not adjusted a second time**

> **Given** a resolved amount already has its scale (for example "million") and its
> sign folded into the figure
> **When** the system normalises it
> **Then** the scale and sign are not applied again
> **And** the resulting figure is not multiplied or negated twice.

---

**FR-5.3 — Where text must be read for a money value, ambiguity is refused, not guessed**

> **Given** a money column with no already-resolved amount to draw on, so the written
> text must be interpreted
> **When** the system interprets the amount
> **Then** it handles each of the following correctly, or refuses the value:
>
> | Written in the document | Required outcome |
> | --- | --- |
> | `$1.234,56` | one thousand two hundred and thirty-four dollars and fifty-six cents |
> | `$1 234,50` | one thousand two hundred and thirty-four dollars and fifty cents |
> | `-$500.00` | negative five hundred dollars — the sign is preserved |
> | `($1,234.56)` | negative one thousand two hundred and thirty-four dollars and fifty-six cents — accounting brackets are a credit |
>
> **And** where the digit grouping is genuinely ambiguous, the value is marked
> **needs review** rather than resolved to a best guess.
>
> *Business rationale: a previous implementation turned `-$500.00` into a positive
> five hundred, and read a credit as a debit. A refusal is recoverable; a confident
> wrong number in a financial report is not.*

---

**FR-5.4 — Dates are normalised to an unambiguous standard form, day-first by default**

> **Given** a column is constrained to a date
> **When** the system normalises an extracted date
> **Then** the normalised value is expressed in ISO 8601 form (`YYYY-MM-DD`)
> **And** where the source is written numerically, it is read day-first, consistent
> with Australian convention.

---

**FR-5.5 — An ambiguous date is flagged, not assumed**

> **Given** an extracted date whose meaning cannot be determined with confidence
> **When** the system normalises it
> **Then** the value is marked **needs review** rather than resolved to one reading.

---

**FR-5.6 — Normalisation never destroys the original wording**

> **Given** any value that has been normalised, successfully or otherwise
> **When** the user inspects that value
> **Then** the text exactly as extracted from the document is still available alongside
> the normalised form
> **And** where normalisation failed, the original text is retained and the value is
> marked **needs review**.

---

### 4.6 Statuses and what reaches the report

---

**FR-6.1 — Every value carries exactly one of three statuses**

> **Given** a run has completed a document
> **When** the user inspects any value in that row
> **Then** it carries exactly one status:
>
> | Status | Means |
> | --- | --- |
> | **Verified** | The evidence check passed and, where constrained, normalisation succeeded |
> | **Missing** | Nothing answering this column was found, and a reason is recorded |
> | **Needs review** | Evidence failed a trust rule, normalisation failed, or the value arrived with no evidence |

---

**FR-6.2 — Only verified values reach the final report**

> **Given** a completed run containing verified, missing and needs-review values
> **When** the final report is produced
> **Then** only verified values are presented as report content.

---

**FR-6.3 — A withheld value must never look like an empty one**

> **Given** a row containing one value that is genuinely absent from the document and
> one value that was extracted but failed a trust rule
> **When** the user views the results or the export
> **Then** the two are visually and textually distinguishable
> **And** neither is rendered as an indistinguishable blank cell.

---

**FR-6.4 — There is no approval workflow inside the product**

> **Given** a value marked missing or needs review
> **When** the user views it
> **Then** no approve, accept, override or sign-off action is offered
> **And** the value is carried into the export flagged, for the user to resolve using
> their own process outside Redline.

---

### 4.7 Export

---

**FR-7.1 — A completed run exports as CSV and as XLSX**

> **Given** a completed run
> **When** the user exports it
> **Then** they can obtain the report as a CSV file and as an XLSX spreadsheet
> **And** both contain the same rows, columns and flags.

---

**FR-7.2 — The export is one row per document and one column per field**

> **Given** a run over fifty documents against a definition with twenty columns
> **When** the user exports it
> **Then** the export contains fifty data rows and twenty field columns.

---

**FR-7.3 — Flagged values are visible in the export**

> **Given** an exported run containing at least one needs-review value
> **When** the user opens the export
> **Then** that value is present and identifiable as flagged, together with its
> recorded reason
> **And** it is not exported as a blank cell.
>
> *This is the requirement that makes the export the review surface: everything a
> reviewer needs to chase down is in the file they already have.*

---

### 4.8 The user interface

---

**FR-8.1 — Column editor**

> **Given** a user wants a report
> **When** they open the column editor
> **Then** they can add, edit, reorder and remove columns, setting each column's name,
> description and optional constraint.

---

**FR-8.2 — Document picker**

> **Given** a prepared corpus
> **When** the user opens the document picker
> **Then** they can see the available documents and select those the run should cover.

---

**FR-8.3 — Run and progress**

> **Given** a definition and a document selection
> **When** the user starts the run from the interface
> **Then** the run begins and its progress is shown in the interface until it completes
> or fails.

---

**FR-8.4 — Results are shown read-only**

> **Given** a completed or in-progress run
> **When** the user views the results table
> **Then** they can read the extracted values and their statuses
> **And** no editing, approval or override control is present anywhere on that table.

---

**FR-8.5 — Export is reachable from the interface**

> **Given** a completed run displayed in the interface
> **When** the user chooses to export
> **Then** they obtain the CSV or XLSX file described in FR-7.1.

---

## 5. Assumptions

1. A corpus has already been prepared before a report run starts. Preparing a corpus
   (loading documents, extracting their text and structure, identifying monetary amounts
   and entities) is upstream of these requirements and is not described here.
2. Document preparation output is available to Redline for reading, scoped to a single
   named preparation run (see FR-2.4).
3. The extraction step is performed by a language model. Which model is used is a
   deployment decision, not a functional requirement — but the trust rules in §4.4 apply
   regardless of the model chosen.
4. Extraction quality is bounded by what the document actually contains and by the
   precision of the user's column descriptions. Redline's guarantee is provenance and
   honest flagging, not completeness.

## 6. Open questions for the reviewer

1. **Flagging convention in the export.** FR-6.3 and FR-7.3 require a withheld value to
   be visibly distinct from an empty one, but do not specify the convention (a status
   column beside each field? an in-cell marker? cell shading in XLSX only?). CSV cannot
   carry formatting, so this needs one convention that works in both formats.
2. **Run cancellation.** Nothing in the current plan describes stopping a run once
   started, or what happens to rows already completed. Should a partially complete run be
   exportable?
3. **Re-running a definition.** If the same definition is run twice over the same
   documents, are both results retained and comparable, or does the later run supersede
   the earlier one?
4. **Column count ceiling.** FR-3.1 answers all columns in one pass per document. Is
   there a practical upper limit on columns that should be stated to users up front?

## 7. Traceability

| Requirement group | Source in `Redline-Plan.md` |
| --- | --- |
| §4.1 Defining the report | Product statement "Input"; §2 data model; §5 constraints decision |
| §4.2 Selecting documents and starting a run | Product statement "Run" 1–2; §2 `ReportRun`; §8 blocker 1 |
| §4.3 Extracting values | Product statement "Run" 3; §4 extraction call contract |
| §4.4 Trust rules | §4 rules 1–3 and the graph-is-not-evidence rule; §6 status table |
| §4.5 Money and date normalisation | §5 constraints and normalisation |
| §4.6 Statuses and what reaches the report | Product statement "Run" 4–5; §6 |
| §4.7 Export | Product statement "Run" 6; §7 |
| §4.8 The user interface | §3 UI row; §9 build step 10 |
| §2 Out of scope | Decisions taken 2026-08-17; §1.1 v1 retrieval scope |
