# Agent Note: Pin complete SubAgent role definitions to identities and runs

Status: implemented

[Shared roles and interface versions](2026-10-15-workflow-role-interface.md) owns role/target/verify wiring and explicit interface upgrades. [Persistent source capabilities](2026-10-15-subagent-source-capabilities.md) owns shared source, permission and project-context rules. This note retains definition loading and pinning. These are shared-runtime mechanisms; [Personal product entry](../simplification/2026-10-18-personal-product-entry.md) retires their old Personal assembly.

## Problem

Configurable roles must keep their original definitions after file edits/deletion, message-triggered execution and backend restart. A name or path alone lets an identity drift; falling back to a built-in after an invalid override hides the owner's configuration. [Roles versus targets](2026-10-14-configurable-subagent-roles.md) owns the overall choice; this note covers definition, selection and snapshots, not source capabilities, target protection or the new workflow interface.

## Decision

Agent uses the maintained frontmatter parser for built-in general/reviewer and instance Markdown. Only description, tools, permissions and body take effect. Runtime reads the fixed instance agents directory, rejecting links, multiple hard links, non-regular files and identity/byte changes during reading. An invalid override removes the same-named built-in and retains a structured diagnostic. An unverifiable directory provides no built-in fallback; the main session can still inspect errors.

Core inlines complete source text, normalized fields, body, purpose and content digest in SubAgent.definition, avoiding a version table/reference system. The trusted entry fixes purpose to role or host_review. GitHub fixed review bypasses the user catalog and retains its completed-source exception, read-only MCP, no messaging and original idempotency/recovery eligibility. New ordinary identities default to general; continuation/reuse with no role keeps the original definition, and an explicit different role is rejected. Parameter digests include role selection, not configuration content that may change later. Workflow start stores the complete catalog and diagnostics; steps read only that snapshot. Missing/corrupt catalogs reject recovery rather than filling in general.

The parent model's catalog is first written as a JSONL custom entry. Child model text comes from the committed identity and enters the system prompt and prompt artifact. Selection records account for the catalog; SDK signatures cover the body digest. Waiting/internal dialogue uses persisted reference snapshots, never current role files. Reparsing source text must match normalized fields. Send/tool checks still bind the original definition. Model and thinking level come from the actual source task, not the role file.

The schema change rejects old formats without migrating history or backfilling definitions. Store keeps an identity with a bad definition queryable and returns definitionError; execution rejects missing/corrupt definitions. Both instance-import directions retain complete definitions and waiting catalogs and strictly verify digests: invalid sources cannot become runnable role-less identities. SQLite and JSONL are not one transaction; identity registration precedes model-input recording, which precedes sending, preserving reconstructable evidence.

## Related decisions

The [overall role decision](2026-10-14-configurable-subagent-roles.md) is implemented in layers 01-04; this note owns definition and pinned identity only. [Work/identity/task](2026-10-03-work-delegation-subagent-task.md) and [restart recovery](2026-10-05-subagent-restart-recovery.md) retain identities, two-level idempotency, stop verification and no replay. Roles do not alter old main/coding/chat rows or session identity. Sealed archives remain unchanged.

## Alternatives considered

- Store only a path/name: least storage, but deletion/override prevents reconstruction of original model input. Store source text and normalized fields.
- Add a definition-version table: deduplicates across identities, but instance files already provide configuration. Inline snapshots travel directly with imports/archives without a second identity index.
- Reread on each task: immediate editing, but changes existing identities. Files affect only new objects.
- Fall back to built-ins on invalid overrides: keeps default delegation available, but hides invalid configuration and changes the owner's selection. Preserve the error and reject creation with that role.

## Documentation budget

The original update kept only the role definition/disambiguation in the glossary, moved configuration/version behavior to module docs and reused development test navigation. README grew to 3310 characters and CONTEXT from 9948 to 10040, with no content belonging elsewhere. Their budgets rose from 3300 to 3350 and 10000 to 10100 respectively to retain existing propositions and the new concept. These are historical budget decisions, not current page measurements.

## Consequences

Definitions recover without their files and remain diagnosable when damaged, at the cost of full bodies/catalogs stored per identity or run. This layer records tool requirements and permission policy; it alone did not replace old analyze/modify capabilities or target-execution rules. Related layers and the overall decision own evidence for default shell, explicit capability preflight, restricted review and the workflow interface. Snapshot tests cannot establish product experience, real-model behavior or cross-platform isolation; those remain joint acceptance requirements.
