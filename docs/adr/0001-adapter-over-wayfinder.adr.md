# ADR-0001 — Adapter over Wayfinder (not a fork) + Strategy A consumption

- **Status**: Accepted
- **Date**: 2026-07-23

## Context

We are building a **Procurement Evaluation Adapter** (`redline`) that must
integrate two Python systems — **womblex** (document extraction) and **Numbatch**
(no-code classification, extended here for financial table extraction) — and must
present a tabular, sortable in-app review of procurement responses with Excel
export.

Wayfinder already solves adjacent problems: it is a strict hexagonal TypeScript
monorepo (ADR-001 there), it runs Python sidecars (`services/australian-writing-mcp`),
it uses MinIO/S3 through an `IObjectStorage` port, and it owns a typed tabular +
XLSX engine (`field-report-view.ts`, `field-report-pivot.ts`, `computePivot`,
`typedDisplayCell`) that writes real numeric currency cells.

Wayfinder's `@rbrasier/*` packages are **`workspace:*`** — unpublished to npm.
Two constraints follow:

1. Wayfinder forbids heavy Python deps and foreign runtimes inside `packages/*`,
   so we cannot host womblex/Numbatch inside Wayfinder.
2. We still want Wayfinder's typed helpers without copy-paste drift.

## Decision

Build `redline` as its **own repository and an adapter**, never a Wayfinder
fork. Wayfinder is touched only through runtime seams:

- HTTP/MCP to the Python sidecars,
- shared object storage (MinIO/S3),
- a **separate `redline_`-prefixed Postgres schema/DB**.

We never reach into Wayfinder's internals; we depend only on its **ports** and
its **read-only typed helpers**.

### Consumption strategy: **A**, designed as if **C**

| Strategy | Mechanism | Chosen |
|---|---|---|
| A | Wayfinder as a git submodule; extend the pnpm workspace to include `vendor/wayfinder/packages/*` | ✅ for the build |
| B | Wayfinder publishes `@rbrasier/*` to a private registry | ✗ (out of scope; needs Wayfinder release changes) |
| C | Pure runtime integration (HTTP/MCP + shared MinIO + shared schema only) | design target |

We build with **A** (typed reuse) but design every seam **as if C** (fully
runtime-decoupled), so the plugin only ever depends on Wayfinder's ports and can
be severed to a standalone workspace in Thread 16.

### Layering

`redline-domain` (zero deps, Result pattern) ← `redline-application` (use-cases) ←
`redline-adapters` (port implementations) ← `apps/redline-web`. `redline-shared` holds zod
schemas. This mirrors Wayfinder ADR-001/ADR-003.

## Consequences

**Positive**

- Heavy Python runtimes stay out of the TypeScript packages.
- Typed reuse of Wayfinder's tabular/XLSX helpers with zero drift while the
  submodule is present.
- A clean, pre-planned path (Thread 16) to a standalone workspace: only the
  minimum typed seam must be vendored or reimplemented.

**Negative**

- Contributors must initialise the submodule (`git submodule update --init`)
  before `pnpm install`, or `@rbrasier/domain` will not resolve.
- Two package scopes coexist in one workspace (`@redline/*` and
  `@rbrasier/*`); tooling must ignore `vendor/**` for lint/format.

## Enforcement

- `pnpm-workspace.yaml` includes `vendor/wayfinder/packages/*` so `@rbrasier/*`
  resolves as a workspace dependency.
- ESLint restricts `packages/redline-domain/src/**` to relative imports only
  (domain stays framework-free), mirroring Wayfinder's ADR-001 enforcement.
- ESLint ignores `vendor/**` — we never lint or reformat Wayfinder's tree.
- **Thread 1 exit test** (`packages/redline-domain/src/wayfinder-spike.test.ts`)
  imports and runs `typedDisplayCell` from `@rbrasier/domain`, proving Strategy A
  end to end.

## Alternatives considered

- **Fork Wayfinder and add procurement inside it.** Rejected: violates
  Wayfinder's no-foreign-runtime rule and couples our release cadence to theirs.
- **Copy the tabular/XLSX helpers in from the start.** Rejected for the build
  phase: guarantees drift. Deferred to Thread 16 as the deliberate severing step.
