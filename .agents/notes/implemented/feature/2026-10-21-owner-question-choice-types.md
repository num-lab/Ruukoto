# Agent Note: Owner-question descriptions, recommendations, multiple choice and skipping

Status: implemented

[In-task questions](2026-10-30-coding-owner-question-wait.md) changes answer waiting and answered-card placement within a task, while retaining question types, Skip and atomic submission. That decision owns the replacement execution and placement contracts; question types and answer validation remain here.

## Problem

The owner requested a smaller free-input icon, removal of top progress/collapse/close controls, and Skip, option descriptions/recommendations and multiple selection. This supersedes [initial durable questions](2026-10-21-coding-owner-questions.md)'s nonempty/single-choice/top-control restrictions, retaining source checks, whole-batch consumption, unique continuation and in-place answered cards.

## Decision

Coding `ask_user` options accept original strings or `{label, description?, recommended?}`. Preserve string representation for historical/host-operation comparison. Each question has 2-5 distinct nonempty labels up to 200 characters; descriptions are at most 500. Recommended is a display Boolean, never preselection/submission. `multiple: true` requires options; omitted/false is single choice. Free text remains possible for every question.

Single-choice answers retain `{text, option}`; multiple choice uses `{text, options}` with unique in-range indices strictly increasing in question order. Text must equal selected labels joined by newlines in that order. Selection fields are mutually exclusive; handwritten answers have neither. Descriptions/recommendations are excluded from answer text but retained in persisted questions, events and model continuation input.

Skip replaces the current answer with `{text: ""}` and advances; the last question enters batch review. All questions may be skipped. Reject whitespace-only text, empty answers with selection fields, missing questions and forged label text. Review/final cards display skipped status while persisted/normalized model text remains empty. Skipping neither cancels the batch nor resumes early. Pending control-plane verification accepts empty/multiple answers and reuses original keys after reconnect.

Desktop retains only the question at top. Bottom controls keep question number, back/forward, Skip and Next, with one final review/submit. Descriptions follow labels; recommendations follow metadata. Single choice keeps numbering; multiple choice uses checkboxes without another label. Typing clears selections; selecting does not populate free input. Its icon is 12 px. TUI single choice advances on selection; multiple choice toggles with Enter while retaining cursor and offers a separate next action. TUI retains batch cancel/back.

This introduced storage version 48 and control protocol 35: old code cannot interpret new fields/empty answers, so strict versions reject rather than migrate/clear archives; matching old code can read old data. Complete-question pages increase to 256 KiB for three questions, descriptions and 4096-character answers under worst JSON escaping; snapshot previews remain 128 KiB with client rereads.

## Alternatives considered

- Converting all options to objects reduces branches but changes historical operation representation.
- A skipped field is explicit but duplicates the requested empty-answer meaning and expands recovery state.
- Reusing single `option` cannot represent multiple indices; separate `options` preserves old semantics and validates text.
- Keeping 128 KiB risks empty nonprogressing pages after descriptions; increase only complete queries, not snapshots.

## Consequences

Metadata, skipped answers and selections reconstruct through original transactions, snapshots, keyed receipts and model input without guessed answers. Matching client/backend versions are required. New-archive tests do not prove old-archive migration, and daily data/processes are untouched. Historical acceptance/environment scope remains in the offline durable-owner-questions work item.
