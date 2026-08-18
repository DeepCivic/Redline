## Redline Delivery Spec — Baseline: Anti-Fabrication

### Objective

Deliver the minimum viable Redline adapter that prevents fabricated values from reaching exported CSVs. The baseline does not guarantee the model selected the best possible evidence; it guarantees that every non-empty CSV cell is grounded in verified Womblex source content.

The LLM may reason, search, and select. It may not author CSV values.

---

### Core invariant

> Every non-empty CSV cell must be copied from, or deterministically normalized from, verified Womblex evidence. Any value lacking verified evidence is rejected — the cell is left empty or marked for review. No exception.

This is the only guardrail the baseline enforces. Contextual accuracy, row reconciliation, conflict resolution, and confidence scoring are deferred to later maturity phases.

---

### Baseline scope

| Component | Baseline responsibility |
|---|---|
| Womblex source adapter | Read immutable Womblex outputs and expose stable document/chunk/span references. |
| Retrieval/evidence tools | Let the LLM list, search, and retrieve exact text spans from Womblex content. |
| LLM extraction agent | Interpret the user schema, search documents, select evidence spans, and propose structured extraction claims. |
| Deterministic validator | Verify every claim against immutable Womblex bytes. Reject anything unsupported. |
| CSV assembler | Copy or normalize verified evidence into cells. Emit provenance metadata. |
| Wayfinder integration | Use Wayfinder's existing schema editor, run progress, grid, and export. Minimal changes. |

---

### Non-goals (deferred to later maturity)

- Proving the LLM selected the optimal or contextually correct evidence.
- Cross-document row reconciliation and deduplication.
- Multi-candidate conflict resolution beyond safe rejection.
- Review UI for ambiguous cells (export marks them; manual review is out of scope).
- Sophisticated confidence or ambiguity scoring.
- Complex normalization beyond a small allowlisted set.

---

### Agent responsibilities

The LLM agent:

1. Reads the user-defined extraction schema (column names, types, required/optional).
2. Searches Womblex documents and chunks via retrieval tools.
3. Selects evidence spans it believes correspond to each requested field.
4. Submits structured extraction claims — each claim references evidence, never a bare value.
5. Reports missing or ambiguous fields rather than guessing.
6. Never directly writes the final CSV cell value.

The agent's output is treated as a set of **claims requiring validation**, not as trusted data.

---

### Deterministic responsibilities

The validator and assembler:

1. Resolve every evidence reference against immutable Womblex content.
2. Verify the quoted text and offsets match the source exactly.
3. Copy the raw value directly from the verified evidence span.
4. Apply only allowlisted deterministic normalizations (e.g., date reformatting, currency parsing to a canonical form).
5. Reject any claim where the proposed value is not copied from or allowlisted-normalized from the verified evidence.
6. Reject any claim where the evidence reference is malformed, missing, or does not resolve to real Womblex content.

---

### Data contracts

```ts
interface ExtractionSchema {
  columns: ColumnDef[];
}

interface ColumnDef {
  name: string;
  type: "string" | "currency" | "date" | "number";
  required: boolean;
  normalization?: "iso_date" | "decimal_currency" | "none";
}

interface EvidenceReference {
  sourceHash: string;
  chunkId: string;
  pageNum?: number;
  start: number;
  end: number;
  quotedText: string;
}

interface ExtractionClaim {
  rowKey: string;
  column: string;
  evidence: EvidenceReference;
  // No bare "value" field — the validator derives the value from evidence
  proposedNormalization?: "iso_date" | "decimal_currency" | "none";
}

interface VerifiedCell {
  rowKey: string;
  column: string;
  value: string | null;
  status: "VERIFIED" | "REJECTED" | "AMBIGUOUS";
  reason?: string;
  evidence?: EvidenceReference;
}

interface CsvRow {
  rowKey: string;
  cells: Record<string, VerifiedCell>;
}
```

The key design choice: `ExtractionClaim` contains **no `value` field**. The value is always derived by the validator from the evidence span. The agent cannot inject a value it composed.

---

### Failure policy

| Situation | Outcome |
|---|---|
| No evidence provided for a required field | `null`, status `REJECTED`, reason `NO_EVIDENCE` |
| Evidence reference does not resolve in Womblex | `null`, status `REJECTED`, reason `EVIDENCE_NOT_FOUND` |
| Quoted text does not match source bytes | `null`, status `REJECTED`, reason `TEXT_MISMATCH` |
| Evidence resolves but field type validation fails | `null`, status `REJECTED`, reason `TYPE_MISMATCH` |
| Normalization not in allowlist | `null`, status `REJECTED`, reason `UNSUPPORTED_NORMALIZATION` |
| Agent provides a bare value with no evidence reference | `null`, status `REJECTED`, reason `NO_EVIDENCE` |
| Multiple conflicting candidates (later maturity) | `null`, status `AMBIGUOUS`, reason `MULTIPLE_CANDIDATES` (optional in baseline; safe rejection also acceptable) |

Baseline rule: when in doubt, reject and leave empty. A blank cell is always safer than a fabricated one.

---

### CSV output contract

The exported CSV contains:

**User-facing value columns** — one per schema column, containing only verified values or empty cells.

**Provenance columns** (appended, one set per value column or in a companion file):

| Column | Content |
|---|---|
| `<col>_status` | `VERIFIED`, `REJECTED`, `AMBIGUOUS` |
| `<col>_reason` | Rejection reason, if applicable |
| `<col>_source_hash` | Womblex source hash |
| `<col>_chunk_id` | Chunk containing the evidence |
| `<col>_page` | Page number, if available |
| `<col>_raw_text` | The exact source text span the value was copied from |

This makes every cell auditable. A reviewer can trace any value back to the exact Womblex bytes.

---

### Retrieval and evidence tools

The agent has access to these tools. All return immutable Womblex content with stable references:

```ts
// List documents in a corpus with metadata
listDocuments(corpusId: string): DocumentSummary[]

// Full-text search across chunks in a document or corpus
searchChunks(query: string, opts?: { documentId?: string }): ChunkHit[]

// Retrieve a specific chunk by ID
getChunk(chunkId: string): WomblexChunk

// Retrieve an exact text span from a chunk
getEvidenceSpan(chunkId: string, start: number, end: number): EvidenceSpan
```

`EvidenceSpan` is the only object the validator accepts as source of truth:

```ts
interface EvidenceSpan {
  sourceHash: string;
  chunkId: string;
  pageNum?: number;
  start: number;
  end: number;
  text: string; // exact bytes from immutable Womblex content
}
```

The validator independently re-fetches the span from Womblex using the reference. It does not trust the agent's quoted text. It compares the agent's `quotedText` against the freshly retrieved span.

---

### Execution flow

1. User defines extraction schema in Wayfinder's column editor.
2. Redline reads Womblex outputs and indexes chunks for retrieval.
3. Redline starts an extraction run; the LLM agent receives the schema and retrieval tools.
4. The agent searches documents, selects evidence spans, and submits extraction claims (no bare values).
5. The validator resolves every claim's evidence against immutable Womblex content.
6. Verified cells are copied or normalized from evidence; rejected cells are left empty with a reason.
7. Wayfinder renders the grid with values and status; export produces CSV with provenance columns.

---

### Acceptance criteria

The baseline is complete when these tests pass:

1. **Fabricated value rejected.** Agent submits a claim with evidence that does not contain the implied value. Cell is `null`, status `REJECTED`.

2. **Correct copied value accepted.** Agent submits a claim whose evidence span contains the value. Cell is populated, status `VERIFIED`, provenance is complete.

3. **Allowlisted normalization accepted.** Agent submits evidence containing `31/07/2026`; schema requests ISO date normalization. Cell contains `2026-07-31`, status `VERIFIED`.

4. **Non-allowlisted normalization rejected.** Agent attempts a normalization not in the allowlist. Cell is `null`, status `REJECTED`, reason `UNSUPPORTED_NORMALIZATION`.

5. **Evidence mismatch rejected.** Agent's `quotedText` differs from the actual Womblex span at those offsets. Cell is `null`, status `REJECTED`, reason `TEXT_MISMATCH`.

6. **Bare value rejected.** Agent submits a JSON object with a `value` field but no evidence reference. Cell is `null`, status `REJECTED`, reason `NO_EVIDENCE`.

7. **Missing field handled.** Agent reports no evidence found for a required field. Cell is `null`, status `REJECTED`, reason `NO_EVIDENCE`.

8. **Provenance completeness.** Every non-null cell in the exported CSV has non-empty `source_hash`, `chunk_id`, and `raw_text` provenance columns.

---

### Delivery phases

| Phase | Deliverable | Dependencies |
|---|---|---|
| 1. Source adapter + evidence contract | Womblex reader, `WomblexSource`/`EvidenceSpan` types, `listDocuments`/`searchChunks`/`getChunk`/`getEvidenceSpan` tools | Womblex S3/Postgres access |
| 2. LLM tool orchestration | Agent that receives schema, calls retrieval tools, submits `ExtractionClaim[]` with evidence references and no bare values | Phase 1 |
| 3. Validator + CSV assembler | Deterministic validation against immutable Womblex content, allowlisted normalization, CSV assembly with provenance | Phases 1–2 |
| 4. Wayfinder integration | Schema editor hookup, run progress, grid rendering of values + status, export with provenance columns | Phase 3 |
| 5. Test harness and fixtures | Real Womblex sample documents; acceptance criteria 1–8 automated | Phases 1–4 |

---

### What this baseline does and does not guarantee

**Guarantees:**
- No fabricated value can reach the CSV. Every non-empty cell is copied from or allowlisted-normalized from verified Womblex evidence.
- Every exported cell has full provenance traceable to exact source bytes.
- The agent cannot inject values — the data contract has no value field on claims.

**Does not guarantee (later maturity):**
- The agent selected the contextually correct evidence among multiple candidates.
- Rows are correctly reconciled across documents or within multi-record documents.
- Ambiguous cases are resolved — they are safely rejected instead.
- The extracted data is complete or optimal — it is only verified as grounded.

This is the baseline. Everything beyond anti-fabrication is a later phase.