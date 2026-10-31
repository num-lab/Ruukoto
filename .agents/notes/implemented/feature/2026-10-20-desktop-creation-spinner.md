# Agent Note: Show a spinner on the session-creation source row

Status: implemented

## Problem

After creating a session, every workspace add button became disabled until the backend replied, but none showed progress or identified the source request. `CodeState.create` already retained `pendingCreation.busy` for deduplication, yet sending did not trigger repaint.

## Decision

After setting `pending.busy`, `sendCreation` calls `mark()` immediately. Retry/verification semantics remain unchanged. Only the workspace row matching `op === "create_session"` and `params.project_id === project.id` replaces Plus with `Loader2.animate-spin` and a creating-session accessible name. Other creation entries remain disabled through existing pendingCreation state, not additional spinners.

Append `.workspace-row .workspace-add:has(.animate-spin) { opacity: 1; }` in production overrides: otherwise hover-only visibility and disabled opacity hide the spinner. Reuse Tailwind animation and global reduced-motion suppression. Do not modify the frozen stylesheet prefix required by `test/43-desktop-demo.test.ts`.

## Alternatives considered

- Spinners everywhere imply multiple requests although only one can be pending.
- Another UI-only pending field duplicates `busy` and adds success/failure synchronization.
- A toast/progress bar is distant from the initiating action; a local icon is more direct.
- Editing frozen base CSS breaks its byte-prefix contract; append an override.

## Consequences

The initiating plus becomes a spinner immediately, then opens the created session or returns to plus with an error. `test/40-desktop-creation.test.ts` checks `busy` and repaint before response, catching delayed feedback. UI now relies on sendCreation's busy timing; future alternate writers must preserve it. `docs/modules/desktop.md` records source-row-only feedback.
