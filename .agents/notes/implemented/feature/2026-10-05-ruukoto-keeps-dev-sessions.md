# Agent Note: Preserve ordinary development sessions in legacy ruukoto

Status: implemented

[The Personal product entry](../simplification/2026-10-18-personal-product-entry.md) supersedes this legacy Personal scope: the new Personal product neither creates nor submits ordinary development sessions, and old sessions remain archived in place. Coding development sessions and the historical compatibility rationale remain. The decision below documents the old assembly, not a requirement to restore Personal development entry points.

Original source: ADR 0017, supplement on preserving ordinary development sessions in ruukoto.

## Problem

The project's `npm run dev` instance used the ruukoto product with ordinary development sessions. Rejecting their creation/submission merely because it was Personal would immediately break the existing development instance. Switching directly to ruukoto-code was also rejected by data-directory product ownership, so existing profiles needed migration first.

## Decision

The legacy ruukoto assembly retains ordinary development-session creation/submission, and its `npm run dev` continues using them. Coding remains the primary coding entry point; this is compatibility, not a change to the [two products](../architecture/2026-10-02-two-agent-products.md) or their profile isolation.

When fixed roles were retired, the old project-creation entry changed to a workspace prompt only in ruukoto-code. Session-entry eligibility did not acquire a product dimension: SubAgent, main, ordinary development sessions, and retired archives were checked by actual identity. Compatibility did not restore writes to fixed coding/chat roles. [Development launchers](../process/2026-10-09-dev-launchers.md) own their profiles and lifecycle.

## Verification

The owner confirmed this decision in the session-identity interview and the 2026-10-05 fixed-role retirement decision. Historical provenance is the offline copies of `.scratch/architecture/issues/08-session-profile.md` and `.scratch/agent-direction/issues/23-contract-legacy-roles.md`. The latter's dev tests and real-backend smoke verified existing wiring with a model stub, not real IM. The retention decision itself changed no execution logic and had no separately recorded original-ADR test results.

## Alternatives considered

Migrating the development instance to ruukoto-code before rejecting Personal development sessions would align capability strictly with product positioning. However, product ownership forbade a direct switch, and existing profiles plus about 37 default-ruukoto development tests needed migration. The owner kept compatibility to avoid interrupting current work.

## Consequences

This decision preserved existing profiles and development workflows without a product parameter in identity checks. Its cost was that the legacy ruukoto name alone did not imply an inability to code. Removing the compatibility required migration of development profiles and corresponding callers/tests; the later Personal-entry decision owns that removal. The [usage guide](../../../../docs/usage.md) describes current entry points.
