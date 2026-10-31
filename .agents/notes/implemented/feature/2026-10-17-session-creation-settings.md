# Agent Note: New sessions inherit settings at click time

Status: implemented

## Problem

Desktop session creation passed only the directory. The backend then used default mode and model, losing the current mode, model, and effort.

## Decision

`create_session` and `open_workspace` accept optional initial `mode` and `model_selection`; `thinkingLevel` continues to represent effort. Store persists settings with `session.created` in one transaction. No schema change was needed; the protocol changed to version 30.

At click time, Desktop copies the current or most recent Code source, including across workspaces. Closing the last tab retains that source; switching instances clears it. A foreground Personal session does not copy its remote model. Creation and queue resumption are blocked while settings are being saved or their result is unknown, with instructions to verify. Resuming a queue does not confirm settings and cannot clear the same session's unknown-settings marker. A pending creation retains its original request key and settings; replay returns the first result without overwriting later choices.

This extends the [Desktop migration](../architecture/2026-10-17-desktop-demo-v4.md). Original requirements and evidence are in the offline copy of `.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md`.

## Alternatives considered

Setting mode and model after creation avoids extending creation parameters, but introduces partial success, flicker, and an unknown-reply window. Initial transactional persistence is smaller and consistent. A global preference file could survive restarts, but that was not requested; the most recent Code source is remembered only for the current connection.

## Consequences

Regressions cover three creation entry points, four modes, nondefault models and effort, saving and unknown states, replay, and instance switching. An invalid first explicit model is rejected without leaving an empty workspace. CLI/TUI callers omitting the parameters retain previous defaults. Desktop and backend must support the matching protocol, introduced in version 30.
