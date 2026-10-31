# Agent Note: Approve a shadcn desktop demo before production migration

Status: implemented

[Settings management](../../proposed/feature/2026-10-21-desktop-settings-management.md) owns the later expansion of deferred configuration, retaining categorized floating-window visuals and its own acceptance status.

## Problem

The owner requested shadcn desktop components through a frontend-only demo, iterative approval and then strict production migration. After the first review, the owner selected the original `.scratch/desktop-gui/ui-demo.html` as visual authority; invented branding blocks, large headings and fixed inspector tabs were unwanted. That original reference is offline provenance. [Desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md) retains business boundaries.

## Decision

The independent demo, now `verification/desktop-demo/`, uses the original HTML visual baseline plus explicit owner annotations. CSS tokens, fonts, shadows and sample data are extracted directly, with official shadcn components for tree navigation, borderless tab headers, continuous messages, floating composer and dynamic right tabs. The demo uses memory-only data, never Electron or real control APIs.

On 2026-10-16 the owner approved the demo and required production to retain layout, styling and interaction strictly. Backend capabilities absent from UI were listed, not added. The frozen approved-demo and approved-demo-manifest.json now live in `test/fixtures/desktop-baselines/`; original scope is offline at `.scratch/desktop-shadcn/issues/02-desktop-migration.md`. Extra diagnostics/parameter gates from the earlier spec ceased to be UI requirements. Production renderer reuses the same components/CSS while retaining connections, approvals, input recovery, instance isolation and idempotent state. Electron removes only the browser's outer desktop/fake traffic lights in favor of native window chrome. Initial settings retain theme/runtime target, not demo scenarios.

The original offline `.scratch/desktop-shadcn/backend-ui-backlog.md` distinguishes implemented controls from demo interactions without production contracts. Annotations explicitly included attachments, but demo attachments only held name/size. The owner chose minimal backend completion: production attachments and long-diff more use real controls, not sample results. History pages load on top scrolling and approvals load completely. Removed explanation cards stay removed. Accepted stop requests are not proof of interruption; continuation follows backend authority.

## Approved browser annotations

Edit/Write count distinct files; names stay in details with added/deleted counts immediately after them. SubAgents render outside tool groups. Composer left side holds attachment/mode, right side model/send. Command arguments remain visible. Session tabs span conversation/right sidebar above both, independent of main. Opening the sidebar preserves usable layout so input, approval and send remain visible; narrow composer toolbars wrap.

Later annotations match top/left backgrounds and round main's top-left corner. Remove the extra workspace row, internal right-sidebar close button and fixed diff footnotes. The send button shows execution state. During verification, preserve/lock draft and attachments; add them to conversation only after verification. Remove runtime-hint rows, pending-verification cards and unknown-effect cards. Empty files use ordinary content; truncated content expands via more. Popper menus avoid trigger boxes. Flatten diffs, remove approval cards after decisions, use gray right-tab icons and remove hover explanations. Sidebars use fixed-width inner content with outer width/opacity transitions. Closing removes portal menus/restores focus; closed content cannot focus. Reduced-motion settings disable animation.

Sidebar resizing uses native Pointer Capture on inner edges without a layout dependency. Drag/arrow keys update page-local preferred widths retained after collapse: left 180-360 px, right 260-640 px, reserving 220 px for content where possible. Left adjustment first preserves right minimum, then right uses remaining width. CSS clamps/handle ranges share rules; smaller windows clamp and larger ones restore preferences. Drag/key resizing has no width tween, while open/close retains transitions. Extremely narrow windows cannot satisfy both minima plus content width.

Diff horizontal scrolling keeps left line numbers/change markers fixed; all rows share one horizontal range, including short rows. A separator divides right tabs/content. Read activity loses line-range annotations while other descriptions/change counts remain.

Settings changed from a dropdown to a floating window with vertical categories left/settings right. This stage only rearranges existing theme, runtime target and demo state with immediate application. Dialog/Tabs preserve closing, focus return and narrow-window side-by-side layout. The window layout enters migration, not production support for simulated targets/scenarios.

## Real child-session display input

SubAgent bubbles use optional get_task displayInput for the original delegation request. Runtime supplies it only when the direct parent task has a successful, known-effect subagent_delegate operation uniquely matching work, Agent and request key. Task, JSONL and model input retain original host wrappers; ordinary messages/assistant outputs are not replaced. ViewState retains immutable metadata; late details may fill it without rolling back task state, and instance changes clear it. Delegation rows reuse Agent identity state rather than internal-ID tool receipts.

Parsing wrappers saves a relationship read but depends on prompt formatting and risks wrong slices. Persisting another input copy requires schema/recovery changes without present need. Existing successful-call arguments directly trace the request; ambiguous association falls back to original text, not guesses.

## Alternatives considered

- Edit production directly: real state immediately, but mixes visual iteration with behavior regressions and violates the explicit demo-first order.
- Copy only single-file HTML: immediate original visuals, but no reusable shadcn components and migration still needs rewriting.
- Invent new layout/colors: broader exploration, but explicitly rejected by the owner. The selected reference supplies verifiable visual authority.

## Consequences

The original 23 frozen files/hashes define that visual baseline. Production keeps original-style prefixes and official component provenance, appending native adaptation, real Markdown and approval parameters. At minimum body width, approval title/buttons wrap. Conversation/Composer use different keys so session changes do not retain old messages. Frozen copies retain their original note anchors unchanged.

Original engineering, independent review and real-window evidence is offline at `.scratch/desktop-shadcn/evidence/2026-10-16/migration/verification.md`. Owner experience requires final review; real models/SSH were outside offline acceptance, and attachment staging initially had no automatic cleanup.

[AI Elements experimentation](../feature/2026-10-16-demo-ai-elements.md) and [right-sidebar browser/files/preview](../feature/2026-10-16-demo-inspector-tools.md) first changed only the mutable demo, not frozen/production scope. The later owner-approved [current-demo migration](2026-10-16-desktop-current-demo.md) replaces this display version with frozen v2, adding AI Elements, Context/Effort and read-only sidebar tools. Recovery, attachments, paging and original frozen evidence here remain.
