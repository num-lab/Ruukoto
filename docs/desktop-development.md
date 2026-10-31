# Desktop Development

`npm run code -- --desktop` uses the isolated Coding development profile and cannot combine with `--config` or a positional workspace. The launcher owns the backend; the desktop neither starts its own backend nor runs a login shell in this managed path.

Electron-vite rebuilds/restarts Electron for main-process changes, rebuilds preload and reloads rendering, and uses HMR for React. It also watches bundled view/control/core source. The original launcher restarts backend changes. Exit cleans up Electron, electron-vite and the backend process group. Each launch creates a development nonce for React/Tailwind resources. The main process permits reloading only the configured complete development-document URL; other paths open in the system browser.

## Build and Packaging

`npm run desktop:build` produces a macOS Apple Silicon directory application, without DMG, notarization or automatic updates. If dependencies were installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, unset it and run `node node_modules/electron/install.js` before development.

Build checks cover production CSP, single-file CommonJS preload, external dependencies and Electron fuses. Production startup verifies bundle signature and ASAR location, rejects debug arguments/external renderer overrides, and acquires the instance lock before loading Host. The regular application uses login-shell Node at the repository path fixed during build; rebuild after moving the repository.

```bash
npm run code -- --desktop
npm run desktop:build
codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app
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
| Host/build/security | `38-desktop-main`, `38-desktop-personal`, `38-desktop-build`, `desktop-browser-security`, `desktop-startup-security`, `desktop-terminal` |
| Creation/recovery/stream | `39-desktop-recovery-guide`, `40-desktop-creation`, `41-desktop-stream` |
| Conversation/inspector | `42-desktop-inspector`, `43-desktop-demo`, `desktop-attachments`, `desktop-agent-display`, `desktop-context`, `desktop-composer`, `desktop-inspector-tools`, `desktop-tool-activity`, `desktop-demo-v4`, `desktop-session-settings` |
| Files/Git/interaction | `desktop-workspace-files`, `desktop-workspace-git`, `desktop-live-files`, `desktop-interaction-regressions`, `desktop-polish`, `desktop-git-lazy`, `desktop-file-tree-loading`, `desktop-git-layout`, `desktop-git-windowing` |
| Settings | `desktop-settings`, `desktop-settings-models`, `desktop-models-layout`, `desktop-settings-mcp`, `desktop-settings-mcp-backend`, `desktop-settings-computer`, `desktop-settings-web-search`, `desktop-settings-skills` |
| Personal | `desktop-personal-interface`, `desktop-personal-settings`, `desktop-personal-settings-pages`, `desktop-personal-native` |
| Remote/maintenance/pairing | `personal-remote`, `personal-remote-maintenance`, `personal-remote-auth`, `personal-desktop-events` |
| Credential storage | `desktop-personal-credential-storage`, `desktop-mygo-credentials` |
| MyGo | `desktop-mygo` and `cd apps/desktop/mygo && go test -race ./...` |

Names have suffix `.test.ts`. Real Keychain denial/locking/rebuild authorization, artifact-injection negative cases, both-host interaction, Tailscale/systemd and actual model/IM flows need distinct external evidence; substitutes are not real acceptance.

## MyGo Experiment

On macOS Apple Silicon with Go ≥ 1.27.1 and Command Line Tools/Clang, `npm run desktop:mygo` rebuilds/opens MyGo; `npm run desktop:mygo:build` only builds. Output is `dist/mygo/darwin-arm64/Ruukoto MyGo.app`; Electron remains available. The Go module pins MyGo v0.5.5 and initially downloads dependencies. Build explicitly uses `CGO_ENABLED=1` for Security.framework; Bun is unnecessary.

```bash
codesign --verify --deep --strict "dist/mygo/darwin-arm64/Ruukoto MyGo.app"
```

MyGo connects to Code and PA. Rerun after source edits; it does not use Electron HMR or the managed dev entry. WKWebView renders, and a Node child reuses DesktopHost. Node is not bundled: signed resources fix its absolute path/SHA256, sidecar and credential namespace. Startup verifies the bundle/resources, strips injection environment and disallows SIGUSR1 debugging. Code backend/terminal login environments are separately selected and cleaned again before reaching Host. Rebuild after Node content/path or repository changes. On transport failure, verify the original operation before reopening.

Personal configuration, Keychain credentials and pending writes are independent of Electron. Go owns fixed Keychain slots exposed to Node only through private host frames, never renderer events/bindings. `desktop:mygo` signs a development namespace and separate application-data directory; `desktop:mygo:build` signs production. Production rejects argv, `RUUKOTO_DESKTOP_MYGO_USER_DATA` and managed overrides. Each host owns an instance lock; development never reuses production credentials.

The bundled sidecar only requires built-ins; ws optional native extensions use JavaScript fallbacks rather than loading machine-local code. Go race tests cover private frames, startup, locks and exit; actual WKWebView IME, scrolling, selectors, page isolation and appearance remain external acceptance.

See [MyGo design](../.agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md), [PA security](../.agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md) and [development](development.md#desktop-client).
