# /doc-review — Documentation Review

Use this skill when the user asks to review, check, or validate docs before
building, or when a thread spec exists in `docs/threads/` and the user says
"let's build this."

---

## Workflow

1. Read the target thread in `docs/procurement-evaluation-plan.md`, its thread
   spec in `docs/threads/`, and any referenced ADR(s) in full.
2. Extract the key elements that would be implemented (entities, ports, DB
   changes, runtime seams, service work, UI changes). Output this as a bulleted
   list directly to the chat as regular text — do NOT embed it inside the
   `AskUserQuestion` UI. Then use `AskUserQuestion` to ask only: "Is anything
   missing from this list, or would you like to alter any of these before
   proceeding?" Wait for their response before continuing.
3. Incorporate any feedback, then check each item below and output `PASS`,
   `WARN`, or `FAIL` with a reason:

### Checks

| # | Check | Fail condition |
|---|-------|----------------|
| 1 | Thread spec exists and is complete | Missing scope, entities/ports, or sub-components |
| 2 | Thread has a single, verifiable **exit test** | Missing or vague (`_Exit:_` not measurable) |
| 3 | Spec matches the build-plan thread scope | Spec implements something outside the thread |
| 4 | DB changes follow conventions | Wrong prefix (must be `proc_`), camelCase columns, missing `id`/timestamps |
| 5 | Layering respected | Domain gains a dep; application imports an adapter; app reaches into Wayfinder internals |
| 6 | Wayfinder reuse is read-only | Any plan to modify `vendor/wayfinder` |
| 7 | ADRs consistent | Two ADRs make incompatible decisions, or a locked §8 decision is contradicted |
| 8 | Version bump specified and correct | Missing, or PATCH when schema changes |
| 9 | Risks identified | Non-trivial thread with no risk note |

---

## Output Format

```
PASS — Thread spec exists and is complete
PASS — Exit test is measurable (vitest suite asserting X)
FAIL — DB table missing proc_ prefix
WARN — Risk section is sparse; note the womblex JSON-vs-Parquet decision risk
```

**Do NOT proceed to `/build` until all checks are PASS (WARNs are acceptable).**

State clearly at the end: `Ready to build` or `Needs revision — see failures above`.
