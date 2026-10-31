# Agent Note: Control Personal background analysis through host menus

Status: implemented

## Problem

[Model background analysis](2026-10-17-personal-model-work.md) supports delegation/query, but owners otherwise depend on the model for control. Menus must pin original work and entry so a model outage does not prevent cancellation and stale menus cannot act on reused identities. The [overall migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) permits slices around real interfaces; whole-request reporting still needs aggregation.

## Decision

Authenticated local controls and Telegram host menus share work queries, original-result paging, stop evidence, and cancellation facts. Telegram manages only the original bot/owner/generation. Dedicated actions reference delivered host menus, not internal references copied from text. Closing additionally requires the original work to remain the identity's latest work and idle; old menus never follow reuse. Single-work control is not whole-delegation cancellation or final reporting.

Result paging is separate from generation truncation. If the original assistant ends with length, every page reports partial=true and CLI/IM/scheduled summaries say it is only a saved fragment. Reading all pages does not complete the answer. No automatic continuation or change to original Task completion/identity release occurs. Queries project current host-command facts from original work.taskId in every state/page. Current verified facts outrank old child text; CLI/IM/scheduled summaries show them without mixing prior work from a reused identity.

Cancellation intent and Telegram's fixed receipt share one durable commit. While waiting for a reply, the work Task observes its own document. On cancellation it stops every background execution in the original child session, releasing occupancy and finishing only after verified stop. Normal completion also rechecks cancellation. Query uses native Task/original occupancy; faulted is not stop evidence. Reuse existing states without another control Task or execution mirror.

Main selects the new `personal-work-controls` extension, making old programs reject new-menu profiles. Recovery first validates menu/original-work/entry relations, then restores Tasks. The observer changes neither old Task input nor checkpoints, so existing work remains recoverable. [Background work](2026-10-17-personal-background-work.md), model work, [Telegram authority](2026-10-17-personal-telegram-permissions.md), and shared delegation/workflow/OS-stop mechanisms keep their own rules.

## Alternatives considered

Model-only controls reuse wiring but prevent stopping analysis when the model is unavailable. A durable cancellation-control Task could call Harness.abortTask but duplicates Task/receipt relations already represented by work cancellation facts. Bundling whole-request reports requires input aggregation and report/delivery lifecycle first; complete single-analysis controls can ship independently without pretending individual child replies are a final report.

## Verification

Coverage includes bounded history/body pages, cancellation of blocked work, crash after cancellation persistence, retained occupancy on faulted, stale-menu isolation, Telegram entry/generation boundaries, zero-model controls, and non-replay of unknown sends. Real CLI PTY needs no internal keys. Historical narrow/static/Linux evidence is in the offline copy of `.scratch/personal-pi-durable/issues/11-work-controls.md`.

## Consequences

Menus and recovery relations add maintenance. Lists scan native records, adequate for the current isolated-analysis scale; optimize only with evidence from larger histories. [Work notes](2026-10-17-personal-work-notes.md) reuse the original-work menu. Whole-request ownership, external child tools, automatic final reporting, and complete product/platform acceptance remain with the overall migration.
