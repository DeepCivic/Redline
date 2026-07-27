# ADR-0015 — The upstream Python engines are submodules, consumed for what they already do

- **Status**: Accepted
- **Date**: 2026-07-27
- **Supersedes**: [ADR-0013](./0013-numbatch-fork-is-materialised-from-a-pin.adr.md) (in full)
- **Amends**: [ADR-0005](./0005-numbatch-fork-all-but-frontend.adr.md) (the Vendoring clause, again)

## Context

ADR-0013 decided the Numbatch fork would be materialised at build time from a
recorded commit — **no submodule** — reasoning that Wayfinder had just moved to
that mechanism ([ADR-0012](./0012-wayfinder-is-pinned-and-optional.adr.md)) and
one vendoring idiom was better than two.

Two things have since undermined that reasoning.

**The consistency argument does not survive inspection.** Wayfinder is pinned for
a specific, JavaScript-shaped reason: a submodule checkout "drags a repo's entire
package set into our pnpm workspace". Numbatch and womblex are Python. They never
enter the pnpm workspace, so the cost that justified Wayfinder's pin is not a cost
they carry. Applying Wayfinder's mechanism to them copied the conclusion without
the premise.

**The pin never landed, and the gap was not benign.** ADR-0013 acknowledged that
"the pin lands when something in this repo first fetches the fork. Nothing does
today." Nothing ever did. The result was that `services/numbatch/` held only
redline's own overlay, the `numbatch` compose profile referenced four
`infra/docker/*.Dockerfile`s that did not exist on disk, and the profile could
not start. Meanwhile `services/womblex` *was* declared as a submodule but was
never initialised, never fetched by CI, and never consumed by any build.

So for the whole build phase, **neither upstream engine's source was readable in
the tree**. Work proceeded against remembered or documented API shapes rather
than the code. Reading the two trees for the first time showed the cost:

- redline had rebuilt womblex's container image, its pipeline orchestration and
  its S3 staging, all of which the engine ships (`Dockerfile`, `womblex run` /
  `cloud/worker.py`, `store/remote.py`) — and had no equivalent of its batching,
  retry and horizontal scale-out.
- `RealWomblexTextEmbedder` imports `womblex.embed_query` and
  `womblex.embedding_model_id`. Neither symbol exists. The real query-embedding
  path had never been executed against the engine.
- The plan's Thread 50 proposed auto-activating a trained adapter, citing
  Numbatch's ADR-0021 — the ADR that deliberately *removed* auto-activation in
  favour of user-controlled activation plus replay comparison.

None of these are exotic. They are what happens when integration code is written
against a dependency nobody can open.

## Decision

**The upstream Python engines are git submodules, and redline builds on their
shipped capabilities rather than reimplementing them.**

- `services/womblex` — submodule, pinned to tag `v0.2.0`.
- `services/numbatch` — submodule, pinned to `72bcead`. Upstream carries no tags,
  so this pin is a SHA; move it to a tag if upstream starts cutting them.
- **Mechanism follows runtime.** Python upstreams are submodules; the JavaScript
  upstream (Wayfinder) stays a build-time pin, for the pnpm-workspace reason in
  ADR-0012. This is narrower than ADR-0013's "one idiom for both upstreams" and
  is the honest rule: the mechanism exists to serve the constraint, not to be
  uniform.
- **A submodule is upstream source only.** redline's additive overlay moved out
  of `services/numbatch/` to `services/numbatch-extension/`, mirroring how
  `services/womblex-ingest` sits beside `services/womblex`. The submodule tree
  stays byte-identical to upstream so the pin means something and so
  "we never modify the fork" is enforced by structure, not discipline.
- **Upstream images, upstream runners.** Both engines' compose services build the
  engines' own Dockerfiles. redline supplies configuration and the seams
  (ADR-0002, ADR-0003), never a re-implementation of what the engine does.
- **Read the tree before building against it.** Any thread that would build
  something an upstream may already provide reads the upstream first.

## Consequences

- The `numbatch` compose profile can start: the four Dockerfile references now
  resolve.
- CI checks out submodules (`submodules: true`). A clone needs
  `git submodule update --init`; `validate.sh` SKIPs rather than fails when a
  submodule is absent, so a shallow clone stays green — with the caveat that the
  pin-drift guard (check #13) only bites where the submodule is present, which is
  CI.
- The static guards exclude both submodule trees, exactly as they exclude
  `vendor/wayfinder`. `services/numbatch-extension` is redline's code and is
  checked.
- Two submodules is a real cost: a fetch step, a second pin to move, and larger
  clones. Accepted, because the alternative — integrating against a dependency
  that is not on disk — has now demonstrably produced a broken compose profile,
  a duplicated container stack, an import of functions that do not exist, and a
  plan that contradicts an upstream decision it cites.
- ADR-0013 is superseded in full. ADR-0005's Vendoring bullet should be read
  against this ADR; the rest of ADR-0005 (additive-only fork, all-but-frontend)
  is untouched and is now structurally enforced.
