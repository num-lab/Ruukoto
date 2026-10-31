# Postmortems

A postmortem explains a failure that crossed a safeguard: what broke, how it escaped, and which durable protections follow. The escape mechanism matters more than the one-line fix.

| Home | Content |
| --- | --- |
| This directory | Failure mechanism, missed safeguards and resulting checks |
| [Decision notes](../notes/) | Choices, alternatives and consequences |
| GitHub Issues/PRs | Work plan, current progress and verification evidence |

A decision says why we chose a design; a postmortem says why something believed safe was not. When a safeguard is itself a design decision, record it in a note and link it here.

## When to Write

Write only when all three hold: the mechanism is non-obvious even to a careful engineer, a systemic gap in tests/tools/conventions allowed it through, and rediscovery would consume substantial debugging effort. Ordinary typos, clear configuration errors and already-covered routine regressions do not need postmortems.

## Format

Use `NNNN-slug.md`, numbered from `0001` in addition order. The executive summary comes first and stands alone for a thirty-second read.

```markdown
# Postmortem NNNN: <what broke>

Status: resolved | open

## Executive Summary

<Failure, cause, escape mechanism and durable lesson.>

## Impact

<Affected behavior/data/scope and relevant unaffected areas.>

## Timeline

<Key facts in order, including observations that rejected hypotheses.>

## Root Cause

<The mechanism; separate independent causes.>

## Why It Escaped

<Each safeguard that should have caught it, and why it did not.>

## Safeguards

<Concrete tests, checks or workflow changes, linked to their maintained homes.>
```

## Writing

Use verifiable facts supported by code, tests, commits, notes or Issues. Omit unsupported details. Explain failed safeguards rather than merely narrating a fix, and make every resulting protection testable. Use one physical line per paragraph.
