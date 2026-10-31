# Desktop Interaction Preview

A maintained browser preview of the desktop layout and interactions. It uses in-memory fixtures, not live agents, files, Git repositories, models or Personal settings. Production behavior belongs to the [desktop module](../../docs/modules/desktop.md); this preview is a design and regression aid, not native-shell acceptance.

## Run And Check

Run `npm run setup` at the repository root first, then:

```sh
npm --prefix verification/desktop-demo ci
npm --prefix verification/desktop-demo run dev
npm --prefix verification/desktop-demo run check
```

Open Vite's local address. The check covers types, server-rendered interactions, original CSS provenance and a production build. The original HTML and approved snapshots are immutable [test baselines](../../test/fixtures/desktop-baselines/README.md); modifying this preview does not update a frozen approval or authorize production migration.

## Navigation And Input

Code workspaces and Personal share the top session tabs while retaining independent drafts, messages and right-sidebar state. Settings selects appearance, simulated Personal connection and demonstration scenarios. Themes/scenarios apply immediately; connection edits apply on Save. Refresh clears preview state.

`Cmd/Ctrl+B` and `Cmd/Ctrl+J` toggle sidebars; `Cmd/Ctrl+Shift+L` switches theme. Sidebars support drag and keyboard resizing. Each tab group uses equal widths within available space, then horizontal scrolling. Drag reorders within a group; `Alt+Shift+Left/Right` provides a keyboard alternative. Closing or switching tabs preserves the intended session state, and reduced-motion preferences disable movement where appropriate.

Enter submits and Shift+Enter inserts a newline; IME composition does not submit. Draft text and attachment metadata remain until simulated acceptance, then the history receives the message. During execution, empty input offers Stop and nonempty input queues. Attachments keep names and sizes only: the preview does not read or upload their contents.

The composer contains access mode, context, model/effort and send controls. Compact layouts retain accessible names when labels collapse to icons. Context usage and model choices are fictional values, not real prompt statistics or server requests. New sessions inherit the selected effort and start with empty simulated context.

## Messages And Tools

Main and SubAgent message scrollers are independent. Readers at the bottom follow incoming content; scrolling upward keeps the reading position. Recorded reasoning and tool activity appear in order. Read opens a file preview; Edit/Write show inline differences; Bash shows escaped commands and output without executing them. Failures remain explicit, with details available where appropriate.

Running scenarios show the execution tail and bounded reasoning. Completed runs collapse the continuous trace preceding the final answer, while keeping the answer visible and allowing the trace to reopen. Switching scenarios does not execute commands or change real approval state. Approval fixtures expose the command and purpose before a direct approve/reject action.

## Right Sidebar

The browser accepts HTTP(S) navigation and records address-bar/link navigation in the preview. External sites may reject iframe embedding. A browser-only preview cannot read arbitrary local files; file navigation reports that limitation. Session/tab lifecycle preserves or clears navigation state as shown by the fixtures, not by accessing a real browser profile.

The file tree contains memory fixtures, with independent file-preview tabs, syntax highlighting, Markdown/source modes and explicit unsupported/missing cases. Markdown is sanitized; HTTP(S) links open the built-in preview browser. Git graph data is also a fixture: branch/tag badges, commit details, lanes and empty repositories demonstrate layout, not local Git access. Personal hides Code-only file and diff capabilities while retaining browser and SubAgent views.

The simulated Personal connection form stores a host alias and absolute control directory in memory. It checks field syntax but never opens SSH or reports a fabricated online state. Production Personal transport may differ from this historical design scenario; consult current product docs before implementation.

## Provenance

Components in `src/components/ui/` originate from shadcn/ui's official radix-rhea registry, with the [MIT license](SHADCN-LICENSE.md) retained. Message scrolling uses `@shadcn/react` 0.3.1. Code blocks and context displays reuse the installed primitives rather than adding a separate component system. Source highlighting uses highlight.js; rendered content remains text, not executable input.

The active stylesheet combines the approved v4 baseline and its approved CSS patches, with the dependency scan paths adjusted for this directory. `test/43-desktop-demo.test.ts` checks the production comparison; `test/repository-layout.test.ts` verifies frozen bytes. UI changes still require theme, window-size, keyboard and affected-interaction review in addition to automated checks. Work and acceptance are tracked in [GitHub Issues](https://github.com/num-lab/Ruukoto/issues).
