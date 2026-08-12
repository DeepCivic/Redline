# Local (non-redistributable) test corpus

This directory holds **real / non-redistributable** documents used to exercise the
womblex pod locally. Its contents are **git-ignored** (see the root
`.gitignore`) — only this README is tracked. Do not commit documents here; if a
fixture is safe to redistribute it belongs in the sibling `corpus/` instead.

Current local set (not in git):

- `SynthResponse1.pdf`, `SynthResponse2.pdf`, `SynthResponse3.pdf` — synthetic
  tender responses.
- `PIN_2026_0334 - Technology PoC REOI Document.pdf` — the REOI tender document.

Real Australian government documents (Crown copyright) drawn from the
womblex-benchmark collection, added to exercise formats and the money-span path
the synthetic set does not — a deliberately heterogeneous corpus that mixes
tender responses with documents that answer no tender requirement:

- `EXCERPT - n0995 [DE-64778] - ATO annual report 2023-24_DIGITAL-post-tabling2.pdf`
  — native PDF, 5 pp. Money-precision fixture: 6 labelled amounts amid dense
  counts, percentages and en-dashed financial years.
- `EXCERPT - asx-5-august-2025-ccp-annual-report-2025.pdf` — native PDF, 6 pp.
  Money-recall fixture: 55 labelled amounts, currency scale spellings and chart
  data labels. A non-tender annual report.
- `foreign-affairs-and-trade-2025-26-portfolio-budget-statements.docx` — DOCX,
  the only realistic exercise of the DOCX ingest path in this corpus.

The two `EXCERPT` PDFs carry money/entity/graph ground truth in the source
benchmark (`fixtures/womblex-collection/_documents/reports-financial-and-entity/`,
`.money.gt.json` etc.), against which the money-span extractor's output can be
checked.

## Run the engine against this corpus

```sh
WOMBLEX_CORPUS=services/womblex-ingest/tests/corpus-local \
  scripts/womblex-engine-smoke.sh
```

`WOMBLEX_CORPUS` overrides the corpus the smoke test stages into object storage
(default: the redistributable `corpus/`). The engine extracts → chunks →
(embeds, when `ISAACUS_API_KEY` is set) every file here and publishes the Parquet
shards to MinIO under `proc/{evaluationId}/`.
