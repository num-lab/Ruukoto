# Desktop Development

`npm run dev -- --desktop` uses the isolated development profile and cannot combine with `--config` or a positional workspace. The launcher owns the backend; the desktop neither starts its own backend nor runs a login shell in this managed path.

Electron-vite rebuilds/restarts Electron for main-process changes, rebuilds preload and reloads rendering, and uses HMR for React. It also watches bundled view/control/core source. The original launcher restarts backend changes. Exit cleans up Electron, electron-vite and the backend process group. Each launch creates a development nonce for React/Tailwind resources. The main process permits reloading only the configured complete development-document URL; other paths open in the system browser.

## Build and Packaging

`npm run desktop:build` produces a macOS Apple Silicon directory application, without DMG, notarization or automatic updates. If dependencies were installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, unset it and run `node node_modules/electron/install.js` before development.

Build checks cover production CSP, single-file CommonJS preload, external dependencies and Electron fuses. Production startup verifies bundle signature and ASAR location, rejects debug arguments/external renderer overrides, and acquires the instance lock before loading Host. The regular application uses login-shell Node at the repository path fixed during build; rebuild after moving the repository.

```bash
npm run dev -- --desktop
npm run desktop:build
codesign --verify --deep --strict dist/mac-arm64/ruukoto.app
```

Both hosts vendor node-pty runtime, native module and macOS spawn-helper. Electron unpacks native/helper files; MyGo preserves their directory and executable bits. Missing or nonexecutable files fail the build. Real PTY regression cannot be skipped:

```bash
npx tsx --test test/desktop-terminal.test.ts test/38-desktop-build.test.ts test/desktop-mygo.test.ts
```

Desktop dependencies live in `apps/desktop` devDependencies under the root lockfile, including streamdown/code/math/mermaid and rehype-sanitize. `npm ci --omit=dev` does not install Electron. Pure tests do not replace real-host IME, hide/restore, appearance, exit, CSP rejection or HMR acceptance.

## Test Navigation

Find files with `rg --files test | rg desktop`. Select by changed behavior rather than running every desktop test:

| Area | Starting test names under `test/` |
| --- | --- |
| Host/build/security | `38-desktop-main`, `38-desktop-build`, `desktop-browser-security`, `desktop-startup-security`, `desktop-terminal` |
| Creation/recovery/stream | `39-desktop-recovery-guide`, `40-desktop-creation`, `41-desktop-stream` |
| Conversation/inspector | `42-desktop-inspector`, `43-desktop-demo`, `desktop-attachments`, `desktop-agent-display`, `desktop-context`, `desktop-composer`, `desktop-inspector-tools`, `desktop-tool-activity`, `desktop-demo-v4`, `desktop-session-settings` |
| Files/Git/interaction | `desktop-workspace-files`, `desktop-workspace-git`, `desktop-live-files`, `desktop-interaction-regressions`, `desktop-polish`, `desktop-git-lazy`, `desktop-file-tree-loading`, `desktop-git-layout`, `desktop-git-windowing` |
| Settings | `desktop-settings`, `desktop-settings-models`, `desktop-models-layout`, `desktop-settings-mcp`, `desktop-settings-mcp-backend`, `desktop-settings-computer`, `desktop-settings-web-search`, `desktop-settings-skills` |
| MyGo | `desktop-mygo` and `cd apps/desktop/mygo && go test -race ./...` |

Names have suffix `.test.ts`. Signature/resource-injection negatives, both-host interaction and actual model/native-browser flows need distinct external evidence; substitutes are not real acceptance.

## MyGo Experiment

On macOS Apple Silicon with Go ≥ 1.27.1 and Command Line Tools/Clang, `npm run desktop:mygo` builds and opens a signed checkout-qualified development application; `npm run desktop:mygo:build` builds production without launching. Electron remains available. The Go module pins MyGo v0.5.5 and initially downloads dependencies; build uses `CGO_ENABLED=1`.

Let `H` be the first 16 hexadecimal characters of SHA-256 of the repository realpath. Development output is `dist/mygo/darwin-arm64/ruukoto Development H.app`, with bundle identifier `dev.ruukoto.desktop.mygo.development.H`. Its compiled name selects `~/Library/Application Support/ruukoto Development H`; the identifier scopes the default persistent WebKit store under `~/Library/WebKit/dev.ruukoto.desktop.mygo.development.H/`. Production output is `dist/mygo/darwin-arm64/ruukoto.app`, identifier `dev.ruukoto.desktop.mygo`. Use `codesign --verify --deep --strict` on the exact generated application path.

MyGo connects to the local backend. Rerun after source edits; it does not use Electron HMR. A signed `launch.json` binds development/production mode, name, identifier, the four raw development profile slots and Node hash. Startup verifies that binding before creating the window/WKWebView. Only the signed development run build enables debugging; production accepts no development environment override. Backend/terminal environments are selected and cleaned separately; rebuild after Node or repository changes.

Each host retains an instance lock. Managed Electron selects both userData and sessionData beneath its application-data root at `ruukoto Development/<SHA-256 of JSON.stringify(raw4)>` before lock acquisition/readiness. MyGo’s private request/response and `browser_event` sidecar frames remain independent of retired pairing/credential initialization. These are isolation contracts; actual native-state separation still requires the smoke evidence below.

Actual-host checks use a separate verification checkout identity and fresh backend raw tuple, plus verified distinct native application/browser state. If that native separation cannot be established without touching daily state, use a disposable macOS account. Never enable production development overrides to make a smoke pass. Go race tests cover host frames/startup/exit; WKWebView IME, scrolling, selectors, page isolation and appearance require actual interaction.

See [MyGo design](../.agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md) and [development](development.md#desktop-client).
