# Agent Note: Prepare CI system prerequisites explicitly

Status: implemented

[Node 24 and CI budgets](2026-10-24-node24-ci-budget.md) supersedes the original Node support range and job timeout. Platform safeguards, real coverage, and historical results remain.

## Problem

[CI run 39720984008](https://github.com/num-lab/Ruukoto/actions/runs/39720984008) failed all four cells during setup because rg was absent. [The previous run](https://github.com/num-lab/Ruukoto/actions/runs/39457723330) also lacked bubblewrap or user systemd for Linux workflow execution. File-tree regressions failed importing xterm CommonJS named exports through Vite SSR before reaching all UI assertions.

## Decision

Actions installs ripgrep with the system package manager before setup. Linux also installs bubblewrap, AppArmor, and user bus using the existing bwrap profile/user-manager configuration. Set runtime-dir/bus addresses for current and following steps, verify full namespaces and a Delegate=yes user scope, then run original setup/check. setup itself only checks prerequisites, not installs developer software. Retain path-scoped userns authorization and real tests rather than weaken system-wide policy.

File-tree SSR marks xterm and fit addon noExternal so Vite uses declared ESM entries, and adds Inspector's empty terminalTabs fixture. Production loading/terminal behavior stays unchanged. Existing file-tree, error, and new-tab assertions remain without duplicate tests.

Update old fixtures to current contracts: waiting UI does not fix a historical protocol number; Plan allowlists include approved questions/background observation; Desktop creation mocks only a lost reply and sends other requests to a real temporary backend. TUI Demo keeps all event kinds and shares terminal static background/question snapshots, queries, and events; writes still fail. Neither event coverage nor tool sets are weakened to pass.

Disabling Web Search during a project test checks presend allowlisting blocks later requests, not an obsolete error inside a tool never reached. Webhook same-process clients use ten seconds: an isolated timing probe saw server response finish in ~17ms, but subsequent synchronous dispatch delayed response reading beyond a two-second client timer. HTTP returning while the model gate is still blocked still proves it does not wait for review.

Model rollback checks RuntimeApiError/model_config_invalid, original-byte rollback, and nonleakage of internal errors. Work-copy stop fixtures include real delegation/child/integration preparation before the unit appears; fifteen seconds exhausted even in targeted local runs. That fixture waits sixty seconds for actual unit appearance without changing product timeouts or stop assertions.

macOS durable-execution fixtures append TERM markers and require at least one. The supervisor may resend TERM; truncating rewrites could erase prior evidence if KILL interrupts the final write. The original observation was successful stop with an empty marker, not a captured exact syscall sequence. Successful stop, both-stream EOF, wrong-fingerprint non-stop, and non-replay assertions remain.

Nonexclusive app-test batches run at most two files concurrently; existing exclusive macOS batches run one. On the ten-core development host, default file parallelism exhausted 15-60s real-worker waits while targeted reruns passed. Within-test three-Agent concurrency remains. This replaces [joint acceptance](2026-10-13-workflow-joint-acceptance.md) default file parallelism, not batch membership, product budgets, failure propagation, or offline switches. The original timeout rose from thirty to forty-five minutes; the later Node-budget decision owns current limits.

[Suite reduction](2026-10-24-test-suite-reduction.md) later removes retired/duplicate members, preserving prerequisites, failure propagation, concurrency, and exclusivity. [Controlled search](../feature/2026-10-21-controlled-file-search.md) owns rg/no-runtime-download, [native execution](../architecture/2026-10-10-native-execution-sandbox.md) owns AppArmor/user scopes/stop, and [file-tree feedback](../feature/2026-10-17-desktop-file-tree-loading.md) owns behavior.

## Alternatives considered

Skipping prerequisite/native checks restores a green entry fastest but hides missing required execution capability. Auto-installing through setup shares a path but adds privilege/system-policy changes to developer machines; install only in disposable runners. Changing production terminal imports or mocking the entire terminal avoids SSR failure but fixes the wrong layer; Vite already supports real ESM packages.

## Consequences

CI adds package-download/user-manager prerequisites and may fail when runner images change; failures are exposed, not retried or skipped. SSR loads the real inspector but proves no real terminal painting. Historical positive/negative/platform/gap evidence is archived `.scratch/ci/issues/01-restore-ci-prerequisites.md`. Local passes do not replace GitHub matrix results.
