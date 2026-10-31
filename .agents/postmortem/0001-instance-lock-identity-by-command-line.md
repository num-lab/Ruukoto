# Postmortem 0001: A Renamed Checkout Allowed Takeover of a Live Instance Lock

Status: resolved

## Executive Summary

Instance-lock ownership was inferred from product-related substrings in the holder's command line. That depended on checkout/launcher naming, not process identity. In an independently named checkout, a live backend was classified as an unrelated process reusing the PID; a second backend took over its lock and could write the same SQLite/JSONL data. Both macOS and Linux reproduced it. Tests ran in a checkout named `ruukoto`, satisfying the hidden assumption. The fix uses OS-observed process-start identity and tests a real renamed child process.

## Impact

Two backends could believe they owned one profile and concurrently write metadata/history, exposing later corruption or inconsistent state rather than an immediate clear error. The lock's protection was bypassed. This incident concerned holder classification, not the atomicity of the `mkdir` operation itself; it does not establish that every possible lock-creation race is solved. Single-instance operation was unaffected.

## Timeline

- The initial classifier matched `ruukoto`, `cli.ts` or `dev.ts`, described as a conservative choice favoring false rejection over false acceptance.
- On 2026-10-09, reproducible-baseline work (`4d5379c`) ran complete checks in isolated checkouts; Node 24.15 and 24.21 reproduced incorrect takeover.
- Investigation tied the failure to checkout names without `ruukoto`: `looksLikeBackend` classified the live holder as unrelated PID reuse.
- The fix used Linux boot ID plus `/proc/<pid>/stat` start ticks, or macOS `ps -o lstart=`, and shared `probeLockHolder` between acquisition and read-only inspection. Legacy records retained command-line compatibility.
- `test/101-instance-lock.test.ts` added a real renamed child-holder case.

## Root Cause

Command-line text describes how a process was launched, not its identity. Checkout names, linked executable names and launcher scripts all change it. Matching generic `cli.ts`/`dev.ts` also accepts unrelated programs. Both answers could therefore be wrong: a real backend could be treated as stale, or an unrelated process as a backend. OS-observed startup identity avoids dependence on mutable launch naming.

## Why It Escaped

- Tests ran in a `ruukoto` checkout, so their environment always satisfied the hidden name assumption.
- The supposedly conservative broad match ignored the false branch's consequence: returning false authorized takeover. Broad matching was not uniformly fail-safe.
- Lock tests lacked a real second-process contention path; single-process acquire/release did not exercise holder classification.
- Daily development used the product-named checkout. Independent CI/deployment naming exposed the condition.

## Safeguards

- `packages/core/src/instance-lock.ts` obtains process-start identity; inability to verify it rejects startup rather than granting takeover.
- `probeLockHolder` is the shared acquisition/inspection decision point, avoiding drift between two classifiers.
- `test/101-instance-lock.test.ts` verifies a renamed live child, takeover after exit, differing startup identity and unverifiable identity.
- [Repository instructions](../../AGENTS.md) own standing persistence rules; this document owns the specific failure mechanism.
