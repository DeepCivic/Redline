# Thread 37a fixture corpus

A tiny, redistributable document set the `womblex` compose pod extracts as its
exit test (`scripts/thread-37a-womblex-pod.sh`). womblex routes by file
extension; a CSV takes the pandas cell-grained ingest path (README "Other
formats"), needs no binary blob in the repo, and is safe to redistribute.

`tender.csv` is a **fully synthetic, abstracted** procurement tender-response
dataset. It is modelled on the *breadth and structure* of a real REOI response
set (capability-domain responses, compliance/ownership declarations, security
certifications, data-residency posture, currency-typed pricing) but contains **no
real entity, contact, identifier or verbatim content** — every value is
invented and generic. It carries enough structure and breadth for the real
engine to produce meaningful `*.elements` / `*.chunks` shards, and (with an
Isaacus key) real `*.embeddings.parquet`.

Breadth deliberately baked in, so extraction/chunking (and later retrieval) have
something to bite on:

- **Three respondents (A, B, C)** across **seven capability domains** (Access
  Control, Device Management, Reporting, Hosting, Support, Delivery, Compliance).
- A **contrast axis**: two compliant onshore respondents vs. one non-compliant
  offshore respondent (foreign-controlled, no sovereign accreditation, USD
  pricing) — a real signal for classification/retrieval to separate.
- **Currency-typed amounts** in two currencies (AUD/USD) with genuine blanks, so
  the currency-cell path and null handling are both exercised.

Not a benchmark corpus: it exists to prove the engine runs and lands shards, not
to measure retrieval quality (that is Thread 37b's proof, and the
ambiguity-threshold measurement is a further follow-up). Non-redistributable /
real documents belong in the git-ignored sibling `corpus-local/`, not here.

Override the corpus with a real document set via `WOMBLEX_CORPUS=/path up`.
