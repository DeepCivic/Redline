# ADR-0019 — redline's review UI mounts into a forked Wayfinder, carried as a submodule

- **Date**: 2026-08-01
- **Amends**: [ADR-0006](./0006-inherit-wayfinder-auth-roles.adr.md) (the delivery
  vehicle for the control surface — a redline-served "Next.js shell" becomes a
  mount inside a forked Wayfinder `apps/web`); [ADR-0001](./0001-adapter-over-wayfinder.adr.md)
  (the "never a fork" rule — narrowed: a **contributor fork we control**, carried
  as a submodule for the run/mount seam, is not the release-cadence coupling
  ADR-0001 rejected)

## Context

redline is a Wayfinder adapter that must present a sortable, delineated review of
procurement responses **inside Wayfinder's UI**, not as a bolted-on second app
([ADR-0006](./0006-inherit-wayfinder-auth-roles.adr.md): "feel at home in
Wayfinder"). The review grid, pricing pivots, Excel export and the workflow
control surface are all built as framework-free brains + pure view models in
`apps/redline-web/src/lib/` (`review-grid.ts`, `review-view.ts`,
`pricing-view.ts`, `excel-export.ts`, `workflow-manager.ts`, `container.ts`),
green under `./validate.sh`. What has never existed is the thing that *serves*
them — delivery-plan §2 item 3, "the only genuinely missing piece".

Reading Wayfinder at the current pin (0.20.0, `60767f4`) settled how that piece
should land. Wayfinder ships a full **extraction feature** entirely inside its
own tree — `apps/web/src/components/extraction/result-grid-model.ts` (the pure
model), `run-results.tsx` (the `"use client"` surface), `server/routers/extraction.ts`
(a tRPC router registered in the hardcoded `router.ts` list),
`lib/container-extraction.ts` (a module factory hung off the fixed `getContainer()`),
and route pages under `app/(user)/synthesise/`. redline's own layering is the
same shape one seam over: `WorkflowController.openReviewGrid/openPricingPivot/buildWorkbook`
returns `Result`-typed data over `container.repository`, and `renderReviewGridView`
already produces exactly what a client component binds to (headers with
active/next sort direction, display+isNumeric cells, a resolved source `href`).
The two line up almost 1:1; only the tRPC + React binding layer is missing.

But **Wayfinder has no extension point.** `router.ts` is a hardcoded router list;
`getContainer()` is a fixed factory; there is no `mergeRouters`, plugin loader, or
external-router seam anywhere in the tree (searched). So mounting redline's grid
"inside Wayfinder's UI" means editing Wayfinder's `apps/web` — its router,
container and routes. The instruction that governs this is firm: **we do not
commit changes to Wayfinder `main`; if we must edit Wayfinder we fork it, and we
carry a fork as a submodule.** The maintainer here is a Wayfinder contributor
prototyping the integration in a fork first, then deciding how to upstream it.

Two accepted ADRs bear directly on this and must be reconciled rather than
quietly overridden:

- **[ADR-0001](./0001-adapter-over-wayfinder.adr.md) — "never a Wayfinder fork".**
  Its stated reason is release-cadence coupling: "couples our release cadence to
  theirs". That reason targets *depending on a fork instead of upstream ports*.
  It does not speak to a **contributor's own working fork**, pinned by us and
  moved only by us, used to prototype a mount we intend to upstream.
- **[ADR-0012](./0012-wayfinder-is-pinned-and-optional.adr.md) — Wayfinder is a
  pin, not a submodule.** Its reason is JavaScript-shaped and precise: a submodule
  under `vendor/wayfinder/packages/*` is absorbed by redline's pnpm workspace
  glob, dragging Wayfinder's whole package/dependency set into redline's install.
  [ADR-0015](./0015-upstream-python-engines-are-submodules.adr.md) then set the
  honest rule — **mechanism follows runtime**: Python upstreams are submodules
  (they never enter the pnpm workspace); the JavaScript upstream stays a pin
  (it would).

The new fact ADR-0015's rule did not anticipate: we now need to **run and edit**
Wayfinder's `apps/web`, not merely reuse its `domain` types. Running an upstream
we edit is the same need that made womblex and numbatch submodules — and it is a
*different seam* from the typed reuse ADR-0012 governs.

## Decision

**Carry the contributor's Wayfinder fork as a git submodule at
`services/wayfinder`, pinned to a working branch. redline's review UI mounts into
that fork's `apps/web`. The build-time `vendor/wayfinder` typed-reuse seam is
untouched. Two seams, two mechanisms — mechanism follows runtime (ADR-0015).**

- **`services/wayfinder` — submodule of the fork** (`johntooth/wayfinder`),
  tracking a dedicated `redline-integration` branch, not the fork's `main`. The
  fork's `main` stays a clean mirror of upstream so upstreaming later is a diff
  against `main`, not an archaeology exercise. This mirrors `services/womblex`
  and `services/numbatch`: an upstream we run, carried as a submodule, pinned by
  us.
- **The mount lives in the submodule, i.e. in the fork — never in redline's own
  tree, and never in upstream `main`.** The `evaluation` tRPC router, the
  `container-redline.ts` module factory, the `"use client"` components and the
  `app/(user)/evaluations/[id]/{grouping,review,pivots}` route pages are added to
  `services/wayfinder/apps/web`, modelled directly on Wayfinder's own
  `extraction` feature. The fork's `apps/web` imports redline's published
  `@redline/redline-web` / `-application` / `-domain` packages the same way it
  imports `@rbrasier/*`.
- **`services/wayfinder` is NOT in redline's pnpm workspace.** redline's
  `pnpm-workspace.yaml` globs `apps/*`, `packages/*`, `vendor/wayfinder/packages/*`
  — `services/*` is deliberately absent (womblex/numbatch already sit there
  outside the workspace). So the fork's `apps/web` is built and run **by the
  fork's own pnpm workspace**, and ADR-0012's package-absorption objection — the
  whole reason Wayfinder is a pin — **does not apply to this submodule**. This is
  the load-bearing distinction: ADR-0012 forbade a submodule *inside the workspace
  glob*; this one is outside it.
- **`vendor/wayfinder` stays exactly as ADR-0012 left it** — a build-time
  materialisation of the `domain` package for redline's own typed-reuse drift
  check, never committed, guarded by `validate.sh` check #6 (which scopes
  `vendor/wayfinder/**` only, so the new submodule is outside its reach —
  verified). `scripts/vendor-wayfinder.sh` may now source that tree from
  `services/wayfinder` (`WAYFINDER_DIR=services/wayfinder`) so there is one
  Wayfinder checkout on disk, not two.
- **A submodule is a checkout we run, not a fork we mutate freely.** Unlike
  womblex/numbatch (byte-identical to upstream — ADR-0015), this fork *does*
  carry redline-specific commits on `redline-integration`; that is its purpose.
  The discipline that replaces "byte-identical" is: **redline-specific changes
  live only on `redline-integration`; the fork's `main` is never diverged from
  upstream except by merging upstream in.**
- **Auth follows ADR-0006 unchanged.** The mount reuses Wayfinder's
  `viewProcedure`/permission pattern and its Better Auth session; a new
  `evaluation:review` permission key is added on the fork branch, to be proposed
  upstream when the integration is (the deliberate cost ADR-0006 already named).
- **Upstreaming is a later, separate decision.** This ADR gets the integration
  *working* in a fork. Whether it lands upstream as an in-tree feature, or waits
  for Wayfinder to grow a plugin seam, is out of scope here and will be its own
  ADR when the shape is known.

## Consequences

**Positive**

- The review UI genuinely sits *inside* Wayfinder — same chrome, same auth, same
  router — which is what "seamlessly fit Wayfinder's UI" requires, and what a
  redline-served look-alike could never be.
- The seam is the one Wayfinder already validates: redline's `evaluation` feature
  is `extraction` one type over, so there is a working, tested precedent for every
  part (router, container module, client surface, routes, export).
- No change to redline's own architecture guards: `services/*` is already outside
  the pnpm workspace, check #6 already scopes only `vendor/`, and the typed-reuse
  seam is untouched. The two Wayfinder seams stay cleanly separated.
- The existing Playwright specs (`apps/redline-web/e2e/`) finally have a real
  target — the fork's served `apps/web` — closing the `/e2e` deviation in
  `CLAUDE.md`.
- Upstreaming stays cheap: the fork's `main` mirrors upstream, so the redline
  work is always a clean diff on `redline-integration`.

**Negative**

- A third submodule: another fetch step, another pin to move, a larger clone.
  Accepted for the same reason ADR-0015 accepted two — integrating against a
  dependency you cannot open and run is worse.
- Unlike the Python submodules, this one is **not** byte-identical to upstream, so
  "we never modify the fork" is no longer structurally true. The replacement
  invariant (redline changes only on `redline-integration`; `main` mirrors
  upstream) is discipline, not structure, and needs a guard (see Enforcement).
- redline's packages must be resolvable from the fork's `apps/web`. Wiring two
  pnpm workspaces together (fork + redline) is a real mechanics question, settled
  when the mount is built, not here.
- The integration only fully runs when the fork checkout, redline's packages and
  the redline adapters are all present and wired — a heavier local setup than
  `apps/redline-web`'s standalone vitest suite.

## Alternatives considered

- **A standalone redline Next.js app (ADR-0006 as literally worded).** Rejected:
  a redline-served app beside Wayfinder is a look-alike, not a fit *inside*
  Wayfinder's UI; it needs its own serving, its own session bridge, and still
  never appears in Wayfinder's chrome.
- **Grow a plugin/mount seam in Wayfinder `main` first, then mount from redline.**
  Rejected for now: it is a larger, upstream-first change, and the instruction is
  to get the integration working in a fork *before* deciding the upstream shape.
  It remains the likely long-term answer and will be its own ADR.
- **Fold the fork into the `vendor/wayfinder` materialisation and run from there.**
  Rejected: it re-triggers ADR-0012's package-absorption problem (the vendored
  tree *is* inside the workspace glob), and conflates the typed-reuse seam with
  the run/mount seam that this ADR keeps deliberately separate.
- **Commit to Wayfinder `main` directly.** Out of bounds by instruction, and it
  would couple redline to upstream's review/release cadence — the coupling
  ADR-0001 rejected.

## Enforcement

- `.gitmodules` gains `services/wayfinder` beside `services/womblex` /
  `services/numbatch`; CI checks out submodules (`submodules: true`), and
  `validate.sh` SKIPs cleanly when the fork is absent (same posture as the Python
  submodules).
- The static guards exclude `services/wayfinder` exactly as they exclude
  `services/womblex` / `services/numbatch` and `vendor/` (size guard #9, ruff
  `extend-exclude`, the Node lint scope): it is an upstream tree we run, not
  redline source to lint.
- Check #6 (`vendor/wayfinder` not committed) is unchanged and still passes: it
  scopes `git ls-files -- 'vendor/wayfinder/**'`, which the new submodule is
  outside — verified.
- The fork-hygiene invariant is guarded: a pin-drift check (mirroring #13 for
  womblex) confirms `services/wayfinder` is at the recorded `redline-integration`
  commit, and the fork's `main` is asserted to be an ancestor of / identical to
  the tracked `upstream/main` so redline changes never leak onto `main`.
- `apps/redline-web` stays a framework-free package (its vitest suite remains the
  standalone exit gate); the served mount and its Playwright run live in the
  `services/wayfinder` fork.
