# Agent Note: Execute skill scripts without loading their source by default

Status: implemented

[Single-product cutover](../architecture/2026-11-10-single-product.md) retires the Personal-specific portions of this decision. The software-work behavior, source/operation identity and host-security constraints remain; historical evidence is not cutover acceptance.

## Problem

Skill catalog/body/reference wrappers previously allowed scripts only as returned text, forcing models to read implementations before using them and increasing context and tool calls. The original restriction addressed containers unable to see skill directories, execution-account access, and missing interpreters. Both products now had command tools, but actual skill paths remained host-only and absent from restricted execution; removing prompt prohibitions alone would not solve it.

Original restriction and owner approval are offline provenance in retired `.scratch/personal-agent/issues/22-skills.md` and `.scratch/skill-script-execution/issues/01-execute-without-source.md`.

## Decision

Execute through existing `bash`; `skill` remains a read-only loader. Catalogs expose names/descriptions; on-demand loading and explicit `/skill:<name>` expansion include the selected skill’s real directory to resolve scripts. Instructions, arguments and command results should suffice without reading source by default; owner audit or necessary debugging may still read bounded references.

Catalog/body/reference wrappers describe the actual command path, without adding a skill-execution tool or changing the loader’s no-effect semantics. Script output/errors/stacks may contain source; the decision does not promise source never appears.

Only loaded or explicitly expanded skill directories enter history. Do not scan scripts for descriptions or invent entry catalogs. Commands retain task cwd and output permissions; a read-only skill root does not become cwd. Explicit-only skills remain unavailable for autonomous loading.

### Execution resources and authority

Driver supplies directory candidates from the task-pinned library as ToolRouter `skillRoots`. `packages/agent/src/execution/skill-roots.ts` adds actual directories read-only according to final `LaunchSpec.mode`. Pinned instruction text does not pin script bytes: resources are read from disk at execution. Full access retains original scope; a restricted verification step derived from full access still receives read-only roots under its final mode.

Resolve each directory independently through realpath, never mount all HOME or `~/.agents/skills/` as one resource. Reject candidates covering filesystem root or host HOME, including symlinks to either or their ancestors. Normalize/deduplicate; roots fully covered by an existing workspace/grant retain existing permissions with no extra read-only restriction. A new skill root containing a writable root cannot be made wholly read-only and is unavailable.

Missing, protected, realpath-drifted or unsafe-alias roots produce per-skill diagnostics and are excluded while other ordinary commands remain usable. Failures of original workspace/grant/readScope are not downgraded to warnings. Protected-path, identity and hardlink checks remain; alias checking uses the final authorization set and conservatively isolates candidates when whole-set attribution fails.

Before ensuring a worker, recheck candidates and include final realpath/dev/ino roots in `LaunchSpec.readRoots` and the worker key. Resource changes require verified stop of the old unit before replacement. Unverified stop retains occupancy and refuses replacement. A concurrent directory change after final validation may still fail execution; once an operation starts, failure is not permission to filter and retry automatically.

This adds read-only file visibility, not execution authority. Existing tool eligibility, workspace/write grants, network, credentials, approvals, timeouts, capture, stop, and effect-unknown rules remain. Missing interpreter/dependency/credential uses ordinary command failure and existing diagnostics; do not auto-install, grant external paths, or replay uncertain commands.

### History and recovery

Persist model-visible directories in load results or explicit expansion without rewriting committed history. Task-pinned selection and execution-time directory identity remain distinct evidence. Fresh profiles neither import old skill settings nor restore retired PA command-admission/maintenance formats.

## Alternatives considered

- Add a dedicated skill-execution tool exposing only the selected package: stable addressing and less visible data, but duplicates command eligibility/admission/recovery. The owner chose existing tools and accepted read-only visibility of the selected library's discovered directories.
- Remove only prompt restrictions: smallest and sometimes enough in full access, but restricted execution still cannot see HOME skills and models still lack executable paths.
- Copy entire packages at task start: fixes resource versions, but adds copying, dependency layout, storage, and lifecycle concerns. The owner retained disk-at-use reference semantics.
- Ban all source reading: prevents deliberate implementation loading, but blocks owner audit/debugging and cannot prevent script output. Default to not reading, allow it when needed.

## Consequences

Commands can read other files in available skill packages even before a skill is loaded; undisclosed directory names are not a permission boundary. Native alias checks traverse new roots, so large assets/virtualenvs may increase ordinary command preparation cost. Revisit a per-call execution tool if observed cost warrants it; there is no evidence for zero overhead.

Pinned text does not pin scripts: owner file edits affect later execution. External dependencies, account permissions, cwd assumptions and package-local writes can fail under existing command rules.

Retained coverage includes actual bash/load/expansion in `test/56-skills.test.ts`, root/alias protection in `test/native-mount-protection.test.ts`, and stop-before-recreate/unverified refusal in `test/100-worker-stop.test.ts`. Real restricted macOS/Linux execution and model-visible request evidence remain separate acceptance; missing evidence is a gap.
