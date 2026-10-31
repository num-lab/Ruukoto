# Agent Note: Give agent-browser a session-owned host tool

Status: implemented

[MyGo's right-pane browser](2026-10-29-mygo-agent-browser.md) owns its separate desktop tools and takeover rules. This note owns shared Chrome lifecycle/pause behavior. Durable Personal assembly follows [browser/media ownership](../architecture/2026-10-18-personal-browser-media.md), not the old shared Runtime assembly.

## Problem

Main agents needed websites, interaction, screenshots, and existing login state. The original main lacked bash/MCP, while ordinary dev bash/Driver registries were reclaimed per task. Installing only a CLI/skill could not cover main, cross-turn pages, cancellation verification, or attachment without closing user windows. Upstream v0.39.0 retried commands after daemon response loss, so calling it once did not prevent duplicate submission.

Owner Q1-Q15 decisions, research, and lifecycle probes were recorded in retired `.scratch/agent-browser/issues/01-integrate-agent-browser.md`, `research.md`, and `evidence/lifecycle-probe.md` (offline provenance).

## Decision

The original shared assembly exposed `browser` through Runtime-owned `BrowserManager` to full-access owner main/ordinary dev tasks only. Assembly, task allowlist, pre-send, call gate, and execution rechecked the same eligibility; Plan, children, workflows/reports, GitHub, and restricted sources did not inherit it. [Code schedules](2026-10-25-code-scheduled.md) now permits verified scheduled root/continuation provenance; durable Personal separately permits explicitly authorized independent schedules. These are explicit later extensions, not authority inferred from a session label.

Actions use upstream snapshot references and fixed argument arrays, never model-selected program/config/profile/socket/screenshot paths. Pin official native v0.39.1 assets containing the #2085 no-resend fix, validating platform SHA-256 and version. Do not maintain patches/self-built commits or use the npm wrapper. Avoiding its Node >=24 requirement preserved Node 22/24 in the original implementation; the repository now requires Node >=24.15 independently. Missing native binary/Chromium rejects only browser use. The owner prepares dependencies; model tasks do not install or elevate.

### Lifecycle and exclusion

Runtime directly launches/registers/owns Chrome; CLI connects only to explicit CDP. Real probes showed killing the native daemon leaves Chrome in another group and reopening encounters SingletonLock. Daemon process groups therefore do not prove total browser ownership. Reclamation uses PID, group, and boot identity; normal Chrome close first uses CDP `Browser.close`, then checks the entire group and profile-associated processes so SIGTERM alone does not lose new cookies. Attached Chrome is never a host reclamation target: stop only the owned daemon/dashboard.

Profiles are isolated by dataDir/session, with host-generated socket/CLI session IDs and cross-task pages. Native idle timeout is explicitly 60 minutes, including external CDP; human keyboard/mouse input resets it, while the host only observes processes and sends no keepalives. Idle/explicit/backend close retains profiles/history/screenshots. Cold startup verifies old execution stopped, then requires explicit start without restoring pages or replaying actions. Persistent cookies follow Chrome profile behavior; session cookies without expiry and site login duration are not guaranteed.

Attach accepts only loopback. HTTP discovery refuses redirects and rechecks returned WebSocket host/port. Browser UUID is the shared same-UID lock target, so localhost/IP/URL spelling cannot obtain another automation owner; owned Chrome also takes this lock across products. Corrupt locks, ownership mismatch, PID reuse, or uncertain launch windows retain unavailability/occupancy, never kill unverified processes or hide old execution behind a new instance.

`meta.browser_bindings_v1` stores versioned binding, generation, process identity, launch placeholders, pause task, unknown effects, and official sidecar fingerprint. Updates and `browser.binding_changed` commit together in core. Discovery is cancelable and total-time-bounded, so slow streams cannot prevent close. Each command rechecks original daemon/version/source configuration/sidecar and refuses automatic CLI replacement, without copying upstream private hash algorithms. Profiles and SQLite are not atomic, and binding records contain no cookie/password bodies.

### Calls, owner recovery, and images

Normalize bare eN and @eN references, require exposure by the current generation, and take a fresh snapshot to verify continued presence. A single action goes through official stdin batch, so an input such as `--config` cannot become a global flag. Tool and manager execute sequentially. In-flight cancellation stops the CLI and verifies its execution unit. A mutating action with generic failure/disconnection/timeout/cancellation after dispatch is conservatively effect unknown and never resent. Read failure cannot fabricate a write effect, and an unsent new call does not inherit an earlier call's uncertainty.

Failed post-action state persistence preserves original uncertainty. Failed close persistence still reclaims verified units but retains unverified conclusion/occupancy. Known `tab_gone` retains that code; do not parse diagnostic wording to decide retry safety.

For human login, pause first and enter secrets in the headed window or official loopback dashboard, with SSH forwarding on Linux. Dashboard adds no model chat. Pause saves an accepted-event ordering barrier: neither the original task nor input queued before pause may resume; IM uses original message registration order, not later preparation order. A new owner message after pause may resume, beginning with read-only snapshot verification, a new generation, and cleared references. Unknown effects wait for a new task to verify, never turn unavailable into automatic action eligibility. Effective permission changes close the browser used by the affected task and recalculate tools; a queued task must not close another active task's browser in that session.

The host allocates screenshot paths, validates actual MIME, 8 MiB cap, byte length, and SHA-256, and promotes through ArtifactStore into immutable images with vision blocks and artifact references. JSONL/prompt snapshots reconstruct actual model input. Text-only models fail before image send; save failure/oversize never claims the image was seen. [Artifact export](2026-10-14-artifact-file-export.md) owns full retrieval without expanding the control protocol.

## Alternatives considered

- CLI plus skill: least code and useful to dev sessions, but no direct main invocation, cross-turn ownership, or safe attach cleanup.
- Official stdio MCP: reusable tool/image definitions, but at the time only remote HTTP was supported and main had no MCP. Adding generic local transport enlarged configuration/storage/permissions and still reused the CLI daemon without solving lifecycle. Later managed Cua stdio does not retroactively solve this browser decision.
- Per-task browsers: fits registry cleanup but violates cross-turn pages. Letting CLI own Chrome is closest to upstream, but daemon killing leaves Chrome alive; host ownership with explicit CDP addresses that gap.
- Patch/build the upstream fix: earlier availability, but the owner chose a formal release and real post-execution-response-loss count verification.
- Automatically restore saved state: may preserve session cookies, but can load pages and adds state-file/global-directory permission concerns. Keep the profile without cookie/password export or page replay.

## Consequences

Cross-turn browsers consume memory/disk and retain sensitive same-account login data. Cleanup loses live pages but does not auto-delete/share profiles. Arbitrary Chrome takeover needs preparation; websites can demand CAPTCHAs/hardware authentication or refuse automation, so controlled-page success is not universal compatibility.

Pinned native behavior/hash/fingerprint requires rerunning probes on upgrades. Unverified stop retains occupancy for owner verification. Temporary Linux dependencies and disabled sandbox were probe calibration only; production still needs disk, libraries, and a working sandbox. The original record cites dual-product real-model vision evidence but leaves owner experience pending; offline SDK image assertions are not real-model acceptance.

`test/browser-lifecycle.test.ts` covers single-send batch, structural codes, cancellation, loopback, attached cold recovery, PID/lock mismatch, launch windows, and fingerprints. `test/browser-tools.test.ts` exercises real Runtime/SDK/ledger with model fixtures for image history, permission changes, in-flight cancel, stale references, and screenshot failure. Historical macOS Node 22/24 and Linux browser probes and environment gaps live in the retired evidence cited above; export had separate bin/control pagination checks.

[Session backgrounds](2026-10-21-coding-background-processes.md) owns local-preview-service lifetime and browser observation while directories are occupied. [Personal backgrounds](2026-10-21-personal-background-processes.md) is now implemented separately; the broader [background proposal](../../proposed/feature/2026-10-14-bash-background-lifecycle.md) retains overall scope. [Two products](../architecture/2026-10-02-two-agent-products.md), [MCP](../architecture/2026-09-23-mcp-client.md), [full access](2026-10-12-full-access-current-account.md), [native sandbox](../architecture/2026-10-12-personal-native-sandbox.md), and [image reads](../bug-fix/2026-10-12-read-images.md) retain their other decisions. This feature neither broadens restricted permissions nor generic MCP authority.
