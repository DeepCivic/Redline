# /doc-review — Documentation Review

Use this skill when the user asks to review, check, or validate a plan before
building, or when an item has been planned and the user says "let's build this."

---

## Workflow

1. Read, in full: the target item's entry in
   [`docs/delivery-plan.md`](../../docs/delivery-plan.md) (§2 for the lean
   vertical's outstanding items and their exit tests, §3 for the deferred set,
   §5 for sequencing), the parts of
   [`docs/architecture.md`](../../docs/architecture.md) it touches, and any
   referenced ADR(s).
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
| 1 | Item entry is complete | Missing scope, entities/ports, or exit test |
| 2 | Item has a single, verifiable **exit test** | Missing or vague (`_Exit:_` not measurable) |
| 3 | Scope is one build step | Exit test joins two independently-testable behaviours; spans two languages; crosses three packages |
| 4 | **Nothing upstream already does this** | The item rebuilds a capability in `services/womblex` or `services/numbatch` (ADR-0015). Read the submodule to be sure — do not answer from memory |
| 5 | DB changes follow conventions | Wrong prefix (must be `redline_`), camelCase columns, missing `id`/timestamps |
| 6 | Layering respected | Domain gains a dep; application imports an adapter; app reaches into Wayfinder internals |
| 7 | Wayfinder reuse is read-only | Any plan to modify `vendor/wayfinder`; likewise any plan to modify a submodule tree |
| 8 | ADRs consistent | Two ADRs make incompatible decisions, or a settled decision is contradicted. Check against upstream ADRs too — `services/numbatch/docs/adr/` is authoritative for Numbatch's behaviour |
| 9 | Claims are verifiable | The plan asserts an API shape, schema or upstream behaviour that has not been checked against the source |
| 10 | Version bump specified and correct | Missing, or PATCH when schema changes |
| 11 | Risks identified | Non-trivial item with no risk note |

Checks 4, 8 and 9 exist because redline has shipped all three failures: a
container stack duplicating womblex's own, a plan to auto-activate adapters that
contradicted Numbatch's ADR-0021, and bindings written against symbols and
columns that do not exist upstream. Verify against the submodules, not memory.

---

## Output Format

```
PASS — Item entry is complete
PASS — Exit test is measurable (vitest suite asserting X)
FAIL — DB table missing redline_ prefix
WARN — Risk section is sparse; note the content_type join-key gap (architecture.md §7.3)
```

**Do NOT proceed to `/build` until all checks are PASS (WARNs are acceptable).**

State clearly at the end: `Ready to build` or `Needs revision — see failures above`.
