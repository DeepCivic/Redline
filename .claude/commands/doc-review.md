# /doc-review — Documentation Review

Use this skill when the user asks to review, check, or validate a plan before
building, or when an item has been planned and the user says "let's build this."

---

## Workflow

1. Read, in full: the target step's entry in
   [`docs/Redline-Plan.md`](../../docs/Redline-Plan.md) §9 (outstanding build
   steps and their exit tests, §0/§8 for status and known blockers), and the
   parts of the plan's design sections (§1-§8) it touches.
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
| 4 | **Nothing upstream already does this** | The item rebuilds a capability Womblex already provides. Check `docs/Womblex-Output-Contract.md` — do not answer from memory |
| 5 | Layering respected | Domain gains a dep; application imports an adapter |
| 6 | **redline stays read-only and stateless** | The item adds an LLM call, generated content, a database, or any mutable state |
| 7 | Claims are verifiable | The plan asserts an API shape, schema or upstream behaviour that has not been checked against the source |
| 8 | Version bump specified and correct | Missing, or PATCH when schema changes |
| 9 | Risks identified | Non-trivial item with no risk note |

Checks 4 and 7 exist because redline has shipped both failures: a container
stack duplicating womblex's own, and bindings written against symbols and
columns that do not exist upstream. Verify against the contract doc, not memory.

---

## Output Format

```
PASS — Item entry is complete
PASS — Exit test is measurable (vitest suite asserting X)
FAIL — DB table missing redline_ prefix
WARN — Risk section is sparse; note the content_type join-key gap (Redline-Plan.md §3)
```

**Do NOT proceed to `/build` until all checks are PASS (WARNs are acceptable).**

State clearly at the end: `Ready to build` or `Needs revision — see failures above`.
