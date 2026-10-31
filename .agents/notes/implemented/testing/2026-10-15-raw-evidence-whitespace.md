# Agent Note: Preserve trailing spaces in raw verification evidence

Status: implemented

[History cleanup](../../proposed/process/2026-10-30-git-history-evidence-retention.md) moves raw outputs outside Git. Byte preservation still applies to the offline archive; this note does not require putting logs back in Git.

## Problem

Diagnostic blank lines in raw logs can contain spaces, and unified-patch context lines begin with spaces. `git diff --cached --check` treats some necessary data bytes as editing mistakes. Trimming them changes the original output, patch, and fixed digests.

## Decision

Preserve original evidence bytes. The historical `.scratch/subagent-roles/evidence/.gitattributes` limited `whitespace=-blank-at-eol` to raw .log and .patch files in that directory. Other files kept normal whitespace checking, and raw evidence still underwent space-before-tab, trailing-blank-line, and separate EOF checks. Hooks were not disabled and historical evidence was not edited. That local tracking exception disappears with its directory; it is not a global exemption for new artifacts.

[Prose and checks](../process/2026-10-10-postmortem-and-prose-standards.md) still owns source/document whitespace and EOF requirements. This note explains the original data-format exception and the continuing requirement not to rewrite archived raw bytes.

## Alternatives considered

Trimming logs/patches avoids configuration but invalidates originals and digests. Disabling hooks or global whitespace checks admits source defects. Disabling all whitespace checks for an entire file class exceeds the demonstrated format need. The original exception therefore covered only trailing spaces in two local raw-data classes.

## Consequences

Raw output and patches remain byte-verifiable. The original exception suppressed only those trailing-space diagnostics and was not a place for handwritten source. An isolated Git probe failed before the attribute, passed afterward without byte changes, and still rejected source trailing spaces, evidence space-before-tab, and trailing blank lines. Historical probe provenance is `.scratch/subagent-roles/evidence/commit-whitespace-probe.log` in the offline archive.
