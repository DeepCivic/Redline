Disregard and delete delivery plan and end to end corpus 

We need to deliver the below and it should be fairly lean to do. A surface in Wayfinder that reads Womblex outputs to support the below process.

# CorpusDocument-to-Report Extraction Engine

### Input
User defines report columns. Each column has:
- `name`
- `semantic description`
- optional `constraints` — e.g. financial, date, regex, enum
- optional `summary_generation` flag

## Run

1. User selects documents and starts the report run.

2. For each document:
   - Create exactly one report row.
   - Run exactly one base LLM extraction call for that document.

3. The base LLM call:
   - Has access to tools, corpus search, embeddings, and a graph overlay of the corpus.
   - Copies field values from relevant chunks/entities where possible.
   - Returns one value per column, with source evidence if available.

4. Apply constraints:
   - If a field is marked as financial/date/etc., normalise it.
   - If normalisation or validation fails, mark that value for review.

5. If a column has `summary_generation = true`:
   - Run an additional LLM call per document to generate the summary.
   - Do not use the base extraction call for generated summaries.

6. Status handling:
   - Each value is one of: `verified`, `generated`, `missing`, or `needs_review`.
   - Only `verified` or user-approved values go into the final report.
   - Unresolved values are held back and flagged in the spreadsheet.

7. Export:
   - One row per document.
   - One column per field.
   - Unresolved/flagged values are visible for review.
