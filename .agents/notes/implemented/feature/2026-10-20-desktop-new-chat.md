# Agent Note: Create a new-chat session only on its first message

Status: implemented

## Problem

The old flow created an empty workspace session/tab before composing. The owner wanted an unassigned composer first, then workspace selection and the first message before session creation. Project/cwd fix data identity, AccessScope and tool grants at creation; an unassigned UI must be a local draft, not a session later reassigned.

## Decision

Add New chat with SquarePen below Ruukoto/Scheduled on the same 30 px row grid. It opens a draft canvas without a tab/request. Online with no selected session, including after all tabs close, this is the default canvas instead of a workspace placeholder. Remaining empty states are offline connection and unavailable PA main session.

Reuse composer shell and exported ModeSelector/ModelSelector controls, attachment behavior and styling. A DropdownMenu workspace picker sits above/outside the input, initially unselected. Its search filters names live and Enter picks the first result; entries show roots, with distinct no-results/no-workspaces states. A new-workspace action reuses the folder picker/open_workspace. Search stops key propagation so letters do not trigger menu typeahead.

Keep text/mode/model/attachments/workspace in a renderer draft object, not per-session CodeWrites state. Without explicit model selection, inherit the current Code session or backend default; disable sending if still unknown. Sending requires workspace, nonempty text or attachments, and an available model. Enter and button share the predicate.

Only `CodeState.startChat(draft, upload)` creates: use selected `rootDir.cwdReal` with existing `create_session`, explicit mode/model, original request-key idempotency and lost-response checks. Draft attachments cannot upload because `put_attachment` needs session ownership. `pickDraftAttachments` retains local files under app-lifetime temporary tokens; after creation, `uploadDraftAttachments` uploads by token before submission. Upload failure sends nothing and retains the draft. On successful creation, put the draft into the new session composer, submit and switch to its tab.

Pending/refused/failed creation sends no message and retains text with existing feedback; an already pending create is rejected visibly. Switching to any session closes the draft. New chat toggles back to its prior session when one exists; the default page has no prior session and does nothing on a second click.

## Alternatives considered

- Creating then changing workspace requires changing source identity; `session.workspace_mapped` changes display organization only, not cwd/history/authorization.
- A draft tab needs a fake session ID and special cases in ordering/close/sync.
- Making Session-bound Composer handle no session adds optional branches to model/mode/attachment/stop/queue paths; share only controls and own draft state separately.
- Uploading before a session lacks a writable session scope; creating first recreates abandoned empty sessions.
- Precreating on workspace selection still leaves abandoned sessions and violates first-message ownership order.

## Consequences

Before first send, no session/task/history file exists and abandoning leaves no empty session. Text is renderer-memory-only and disappears when leaving the draft/application, like ordinary drafts. Pick from registered workspaces or register one through the existing folder flow. Mode/model follow current Code/default creation rules. The default draft has no collapse destination: switching to a session discards its text.
