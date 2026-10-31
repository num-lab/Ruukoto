# Agent Note: Execute skill scripts without loading their source by default

Status: implemented

## Problem

Skill catalog/body/reference wrappers previously allowed scripts only as returned text, forcing models to read implementations before using them and increasing context and tool calls. The original restriction addressed containers unable to see skill directories, execution-account access, and missing interpreters. Both products now had command tools, but actual skill paths remained host-only and absent from restricted execution; removing prompt prohibitions alone would not solve it.

Original restriction and owner approval are offline provenance in retired `.scratch/personal-agent/issues/22-skills.md` and `.scratch/skill-script-execution/issues/01-execute-without-source.md`.

## Decision

Execute through existing `bash`/`run_command`; `skill` stays a read-only loader, and Personal main still delegates commands to a child. Catalogs initially expose names/descriptions. On-demand loading and explicit `/skill:<name>` expansion include the selected skill's real directory for resolving relative script paths. Body instructions, arguments, and command results should suffice without reading source. Owner-requested audit or necessary debugging may still read references, retaining path/realpath/UTF-8/64 KiB checks.

Update catalog, body, reference wrappers, and both products' tool descriptions to the actual available command path: Coding bash, Personal child run_command, or main delegation. Historical requests containing old prohibitions then receive current actionable guidance. `skill` itself does not execute, change its no-effect ledger, or lose Personal safe replay. Script output/errors/stacks may contain source; this decision does not promise source never appears.

Real directories enter history only for the loaded/explicitly expanded skill, not all host paths. Do not scan scripts to generate descriptions, add script-type detection, entry catalogs, or template syntax. Commands retain the current task or configured command cwd and original output permissions; exposing a read-only skill directory does not make it cwd. Explicit-only skills remain unavailable for autonomous model loading. Personal main may delegate the concrete command/arguments/target obtained by expansion without copying source or widening reference-read eligibility.

### Execution resources and authority

Coding uses directory candidates from the task-pinned library supplied by Driver as ToolRouter `skillRoots`. Personal uses the originating model request's `references.skills.snapshotEntry`, resolved by `personalModelRequestSelection`. Shared `packages/agent/src/execution/skill-roots.ts` adds the actual directories read-only, including same-package resources, according to final `LaunchSpec.mode`. Fixed instruction text and execution-time script contents are distinct: scripts/resources are read from disk at execution, not copied or package-version-pinned. Real full access keeps its original launch arguments/file scope; a full-access source whose verification step is actually restricted still receives read-only skill roots under the final mode.

Resolve each directory independently through realpath, never mount all HOME or `~/.agents/skills/` as one resource. Reject candidates covering filesystem root or host HOME, including symlinks to either or their ancestors. Normalize/deduplicate; roots fully covered by an existing workspace/grant retain existing permissions with no extra read-only restriction. A new skill root containing a writable root cannot be made wholly read-only and is unavailable.

Missing/protected/realpath-drifted/unsafe-alias roots are diagnosed per skill and excluded, while other ordinary commands remain usable: Coding appends host guidance to the tool result; Personal records `unavailable` in command evidence. Never downgrade failures of the original workspace, grants, or `readScope` into a skill warning; those fail normally. Existing protected-path, directory-identity, and hardlink checks remain. Alias checking uses the final authorization set, allowing legitimate links between two authorized skill roots; if whole-set attribution fails, eliminate candidates and isolate individually, remaining conservative.

Before ensuring a worker, recheck candidates and include final realpath/dev/ino roots in `LaunchSpec.readRoots` and the worker key. Resource changes require verified stop of the old unit before replacement. Unverified stop retains occupancy and refuses replacement. A concurrent directory change after final validation may still fail execution; once an operation starts, failure is not permission to filter and retry automatically.

This adds read-only file visibility, not execution authority. Existing tool eligibility, workspace/write grants, network, credentials, approvals, timeouts, capture, stop, and effect-unknown rules remain. Missing interpreter/dependency/credential uses ordinary command failure and existing diagnostics; do not auto-install, grant external paths, or replay uncertain commands.

### History and recovery

Persist model-visible directories in load results or explicit expansion without rewriting committed history. Personal's `expandSkillCommandLegacy`/`skillBlockLegacy` are frozen old-format generators: SkillExpansion verification accepts only byte-reconstructible old or new format, rejects tampering, and adds no generic migration layer.

At command admission, resolve the original tool's assistant/generation through `personalModelRequestSelection`, verify that library with `personalSkillLibraryAt`, and record original snapshot reference, selected final directory identities, and per-skill unavailability in `CommandAdmission.skills`/`Command.skills`. After admission, restart or later skill refresh verifies original selection/spec/input/fingerprint rather than reading mutable `PersonalSkillsDoc.current` or rediscovering a replacement library. Started commands only verify their original execution. Old commands without these fields retain the old zero-skill-root structure, never receive current roots. Old snapshots/load results/expansions/hashes preserve bytes; old programs unable to understand new evidence must refuse rather than downgrade recovery.

## Alternatives considered

- Add a dedicated skill-execution tool exposing only the selected package: stable addressing and less visible data, but duplicates command eligibility/admission/recovery. The owner chose existing tools and accepted read-only visibility of the selected library's discovered directories.
- Remove only prompt restrictions: smallest and sometimes enough in full access, but restricted execution still cannot see HOME skills and models still lack executable paths.
- Copy entire packages at task start: fixes resource versions, but adds copying, dependency layout, storage, and lifecycle concerns. The owner retained disk-at-use reference semantics.
- Ban all source reading: prevents deliberate implementation loading, but blocks owner audit/debugging and cannot prevent script output. Default to not reading, allow it when needed.

## Consequences

Commands can read other files in available skill packages even before a skill is loaded; undisclosed directory names are not a permission boundary. Native alias checks traverse new roots, so large assets/virtualenvs may increase ordinary command preparation cost. Revisit a per-call execution tool if observed cost warrants it; there is no evidence for zero overhead.

Pinned text does not pin scripts: owner file edits affect subsequent execution. External dependencies, another host account, cwd assumptions, or package-local writes can still fail. Personal does not automatically inherit Coding's host node_modules.

Verification covers source-marker absence in load/expansion/normal execution requests through real bash in `test/56-skills.test.ts`, while intentional source reads remain. `test/native-mount-protection.test.ts` covers root selection/isolation/aliases/protection; `test/100-worker-stop.test.ts` covers worker keys, stop-before-recreate, and unverified refusal; `test/personal-command-work.test.ts` covers original request snapshot, tampering, and old fieldless recovery; `test/personal-skills.test.ts` covers byte-exact legacy expansion and forgery refusal. Real restricted macOS/Linux execution and both products' real-model loops require external acceptance; missing evidence must remain a gap.
