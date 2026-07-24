# ADR-0006 — Auth/roles: inherit Wayfinder's, do not build our own

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

Build-plan §8 decision #5 was left open: *does the review surface reuse Wayfinder
auth/roles, or its own?* — to be decided before the control surface (Thread 11)
grew a real user-facing route. Thread 11 landed the control-surface *logic* as a
framework-free core with no identity layer yet, so this is the moment to lock the
decision before the Next.js shell that serves it is built.

redline is an **adapter for Wayfinder** ([ADR-0001](./0001-adapter-over-wayfinder.adr.md)),
not a standalone product. Wayfinder already has a complete, hexagonal auth/roles
model (verified in `vendor/wayfinder`, not from memory):

- **Identity** — `packages/domain/src/entities/user.ts` (`User { id, email, … }`).
  Login is **Better Auth** (magic-link / passwordless) with **Microsoft Entra ID**,
  implemented in `packages/adapters` (Wayfinder README + CLAUDE.md).
- **Roles & permissions** — `packages/domain/src/entities/role.ts` (`Role`) and
  `entities/permission.ts` (a `PermissionKey` union: `"chat:create"`,
  `"workflow:create_own"`, `"group:manage_own"`, …); `ports/role-repository.ts`
  (`UserRoleAssignment { userId, roleId }`); the application use-case
  `role/list-roles.ts` (`RoleWithPermissions`).
- **Resource-scoped access** — per-resource participant roles
  (`entities/session-participant.ts`: `"owner" | "collaborator" | "viewer"`) resolved
  by an application use-case (`session/resolve-session-access.ts`) into a
  `SessionAccess { role, canSend, … }`, surfaced to the UI as `SessionAccessOutcome`
  (`apps/web/src/lib/session-access.ts`) and `use-permissions.ts` (`isAdmin`).

Inventing a parallel identity/role system in redline would duplicate all of this,
create a second login and a second source of truth for "who may do what", and break
the "feel at home in Wayfinder" goal.

## Decision

**redline inherits Wayfinder's auth and roles. It does not build its own identity,
login, or role model.** The specialist control surface and review grid authenticate
the same Wayfinder user and authorise against the same Wayfinder roles/permissions.

Concretely, consistent with ADR-0001's "depend only on Wayfinder's ports, design as
if C":

- **Identity/session is a port, resolved by an adapter.** The app reads the current
  Wayfinder `User` (and, where relevant, admin/permission state) through an injected
  port whose adapter reads Wayfinder's Better Auth session — the same seam Wayfinder's
  own apps use. redline never re-implements Better Auth or Entra ID.
- **Authorisation reuses Wayfinder's permission vocabulary.** Procurement actions map
  onto Wayfinder `PermissionKey`s / roles rather than a new redline-only scheme. New
  procurement-specific permission keys, if genuinely needed, are proposed **upstream**
  to Wayfinder's `permission.ts`, not forked locally — so there remains one source of
  truth.
- **Resource scoping follows the participant-role pattern.** Access to an evaluation
  (and its response groups) resolves through an application use-case returning a
  Result-shaped access decision (mirroring `resolve-session-access.ts` →
  `SessionAccess`), which the UI consumes the way Wayfinder consumes
  `SessionAccessOutcome`. No new bespoke ACL engine.
- **The gate lives at the app/use-case boundary, not in the domain.**
  `redline-domain` stays identity-free (zero deps; it already knows nothing about
  users). The auth port and its checks live at the `redline-application` /
  `apps/redline-web` edge, wired in `lib/container.ts`.

**On the Numbatch UI:** its SvelteKit frontend is not run (ADR-0005) and is not an
auth reference. We may borrow *interaction/design ideas* from it, but the adapter's
identity, roles, and overall look-and-feel target **Wayfinder**, so redline feels
like part of Wayfinder rather than a bolted-on second app.

## Consequences

**Positive**

- One login, one user, one role/permission source of truth — no divergence, no second
  identity store to secure or keep in sync.
- redline "feels at home in Wayfinder": same auth, same roles, familiar access model.
- `redline-domain` stays pure and identity-agnostic; the auth concern is a port at the
  app edge, unit-testable with a fake principal (same posture as every other seam).
- A deployment can still collapse redline into a shared Wayfinder instance (ADR-0001
  "as if C") because the only coupling is Wayfinder's auth *port*, not its internals.

**Negative**

- redline cannot run *fully* standalone without a Wayfinder auth provider; a
  dev/air-gap mode needs a stub principal adapter (a small in-memory implementation of
  the auth port — cheap, and consistent with the stub-first posture of Threads 3/5).
- Genuinely procurement-specific permissions require an upstream Wayfinder change
  (a deliberate cost to preserve a single source of truth).
- The exact Better-Auth session-read wiring is a real integration point that only
  fully resolves when the Next.js shell + Wayfinder are running together
  (Thread 16 / deployment).

## Alternatives considered

- **redline builds its own auth/roles.** Rejected: duplicates Wayfinder, creates a
  second login and a second source of truth, and contradicts the adapter goal.
- **No authorisation (trust the network).** Rejected: procurement data is sensitive;
  "who may view/advance/finalise an evaluation" is a real requirement.
- **Copy Numbatch's SvelteKit auth.** Rejected: that frontend is not run (ADR-0005),
  and the adapter should look and behave like Wayfinder, not Numbatch.

## Enforcement

- Build-plan §8 decision #5 row is **LOCKED** and references this ADR.
- The auth/principal seam is a **port** consumed by `redline-application` /
  `apps/redline-web` and wired in `lib/container.ts`; `redline-domain` imports nothing
  identity-related (purity check #4 already forbids external imports there).
- The control-surface routes (Next.js shell, Track 4 follow-up) resolve the current
  Wayfinder user through that port and gate actions on Wayfinder permissions; a stub
  principal adapter covers dev/air-gap and the tests.
