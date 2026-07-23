# ADR-0004 — Requirements are user-defined criteria (not a fixed 1–6 profile)

- **Status**: Accepted
- **Date**: 2026-07-26

## Context

The original build plan (§1, §5, §6) and the Thread 2 domain encoded procurement
**requirements as a fixed set of six** — `REQUIREMENT_NUMBERS = [1..6]`,
`RequirementNumber = 1 | … | 6`, `ProcurementResponse.requirementNumber: 1..6` —
described as "a Numbatch-*profile* constant, not user configuration." The
per-requirement *categories* were the only user-defined axis.

Reviewing Numbatch as built (DeepCivic/Numbatch — `docs/ARCHITECTURE.md`,
`docs/DATA_MODEL.md`) shows this was a misread of what Numbatch *is* and what the
product needs:

- Numbatch is a **no-code, user-defined multi-topic classifier**. A **topic** has a
  name + description and is *semantically defined by curated training samples* that
  train a lightweight LoRA adapter. A **profile** bundles **up to 10 topics** (ordered)
  and trains one adapter; batch inference rolls per-chunk predictions up into
  per-document classifications with per-chunk provenance.
- The whole value of Numbatch is that topics are **user-defined and semantically
  trained**. Hard-coding six fixed requirements throws that away and would have us run
  a training/inference platform to serve a constant.
- The product need, restated with the domain owner:
  1. A user has **N requirements/criteria**, not a fixed six.
  2. A user **semantically defines** each requirement/criterion — which is exactly
     what Numbatch topics are (description + sample curation → trained classifier).
     *This is the reason we are using Numbatch at all.*
  3. Financial figures/metrics must be **mapped to requirements automatically, with no
     duplication** — reusing the roll-up's per-chunk provenance rather than
     re-extracting per requirement.

This reverses a decision the Thread 2 domain baked in, so it needs an ADR.

## Decision

**Requirements are user-defined criteria, mirroring Numbatch topics/profiles. Drop the
fixed 1–6 model entirely.**

- **Domain naming: `Requirement` / *Criteria*** (procurement-native), mapped to a
  Numbatch **topic** at the adapter boundary. redline speaks "requirement/criterion";
  Numbatch speaks "topic"; the `NumbatchClassifier` adapter is the single translation.
- A `Requirement` carries an opaque `id`, a `name`, and a **`definition`** (the
  semantic definition). The semantic signal Numbatch actually classifies on is the
  topic's **description + curated training samples**; redline references a requirement
  by `id` and never re-implements classification.
- An evaluation owns a **`RequirementSet`** (mirrors a Numbatch *profile*): an ordered
  set of requirements, **capped at 10** for now (Numbatch's per-profile ceiling; more
  than 10 degrades some base models). If an evaluation needs more than 10 criteria
  later, that becomes multiple profiles — a future ADR, not a domain change now.
- `ProcurementResponse.requirementNumber: 1..6` → **`requirementId: string`**.
- `RequirementClassification.requirementNumber` → **`requirementId: string`**; a
  document may match more than one requirement (roll-ups are multi-label, ≤3 topics),
  and the port already returns an array, so one `RequirementClassification` row per
  matched requirement is the natural shape.
- **Financial mapping, no duplication (Threads 6–7):** a financial figure attaches to a
  **(documentId, requirementId)** pair via the roll-up's matched-chunk provenance.
  Numbatch already dedupes a chunk feeding two topics (`uq_topic_samples_provenance` —
  "the same chunk can feed two *different* topics, never the same topic twice"), so the
  financial worker reads the currency cells for a requirement's *already-deduped*
  matched chunks. One figure per (document, requirement); no per-requirement
  re-extraction.

## Consequences

**Positive**

- The domain now matches Numbatch's real shape, so the `NumbatchClassifier` adapter is
  a thin mapping (requirement ↔ topic, `RequirementSet` ↔ profile) instead of an
  awkward "6 fixed requirements → topics" projection.
- The product delivers its actual value: users define their own criteria and their
  semantic definitions, exactly what Numbatch exists to do.
- Financial extraction inherits Numbatch's provenance dedupe, satisfying "no
  duplication" without new machinery.

**Negative**

- Reverses Thread 2's committed domain. Requires a follow-up domain reshape (Thread 2a,
  below) before Thread 5 builds on it: replace `procurement-requirement.ts`'s fixed
  numbers with the user-defined `Requirement`/`RequirementSet`, and swap
  `requirementNumber` → `requirementId` in `ProcurementResponse`,
  `RequirementClassification`, and (Threads 6–8) `FinancialExtraction`.
- A ≤10-requirement ceiling per evaluation until a future ADR lifts it via multiple
  profiles.

## Alternatives considered

- **Keep fixed 1–6, treat Numbatch's topics as an implementation detail.** Rejected:
  defeats the purpose of Numbatch (user-defined, semantically trained topics) and
  forces a lossy mapping between a fixed catalogue and a variable roll-up.
- **Zero-shot classification from a prose definition (no sample curation).** Rejected:
  Numbatch does not classify zero-shot from a description; it trains a LoRA adapter
  from curated samples. "Semantic definition" is expressed as description + samples.
  Pursuing zero-shot would mean *not* using Numbatch as-is.

## Enforcement

- Build plan §1/§5/§6 rewritten to describe user-defined requirements/criteria; §8
  decision row updated; this ADR indexed in `docs/adr/README.md`.
- Thread 2a (domain reshape) lands the entity changes tests-first; `redline-domain`
  purity (validate.sh check #4) keeps `Requirement`/`RequirementSet` dependency-free.
- The `NumbatchClassifier` adapter (Thread 5) is the only place `requirementId` ↔
  Numbatch `topic_id` is translated; its contract test pins the mapping against a
  captured Numbatch payload.
