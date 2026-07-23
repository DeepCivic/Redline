# numbatch classifier fixtures

`batch-rollup.json` is a **captured Numbatch payload** — the two responses the
`NumbatchClassifier` reads to satisfy one `classifyResponseGroup` call:

- `.job` — the body of `GET /batch-inference/jobs/{id}` once the run has
  **succeeded** (also the shape of the `POST /batch-inference/trigger` response).
- `.documents` — the body of `GET /batch-inference/jobs/{id}/documents`: the
  per-document roll-up (`document_classifications`), each with `source_doc_id`,
  `status`, and a score-sorted `topics` list (`≤3`, per Numbatch's roll-up cap).

Shapes are taken verbatim from Numbatch's own docs (DeepCivic/Numbatch —
`docs/ARCHITECTURE.md` "Batch inference & documents", `docs/DATA_MODEL.md`
`batch_inference_jobs` / `document_classifications`), so the contract test pins
the `topic_id → requirementId` mapping against the real wire shape.

Numbatch's `topic_id`s here (`t-data-residency`, `t-support-sla`) are the ids
redline recorded when it created each topic at profile-bootstrap time; the
`NumbatchProfileBinding` passed to the classifier maps them back to the
evaluation's `requirementId`s.

## Regenerating

Against a running Numbatch stack (see `services/numbatch`), after bootstrapping a
profile and triggering a run over ingested chunks:

```sh
JOB=$(curl -s localhost:8000/batch-inference/trigger \
  -H 'content-type: application/json' \
  -d '{"profile_id":"<profile>","strategy":"majority_vote","source_doc_ids":["82f9355e","5c1a7be0"]}' \
  | jq -r .id)
# poll until succeeded
jq -n --argjson job "$(curl -s localhost:8000/batch-inference/jobs/$JOB)" \
      --argjson documents "$(curl -s localhost:8000/batch-inference/jobs/$JOB/documents)" \
      '{job: $job, documents: $documents}'
```
