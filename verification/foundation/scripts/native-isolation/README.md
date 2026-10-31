# Native Execution Boundary Probes

These probes exercise native execution candidates with temporary synthetic files, services and processes. They read no real credentials, call no model and do not use WorkerLauncher. Platform boundary evidence is separate from worker, SubAgent and approval integration acceptance.

Run from the repository root:

```bash
output="$(mktemp -d "${TMPDIR:-/tmp}/ruukoto-native-probes.XXXXXX")"

# macOS: Seatbelt files, network, credentials, IPC and cumulative process-tree stopping.
bash verification/foundation/scripts/native-isolation/macos-run-probes.sh "$output"

# macOS: preexisting read-only hardlink counterexample; expected exit 1.
python3 verification/foundation/scripts/native-isolation/macos-hardlink-probe.py "$output"

# Real Linux: bubblewrap and host namespaces.
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py --output-dir "$output"
```

[Linux instructions](linux-README.md) cover binary paths, self-checks and deployment. Reports are written under the external `$output` directory. Use a fresh destination for each run and retain required evidence in the offline archive; `verification/foundation/results/` contains historical reports, not rerun destinations. These legacy scripts default to that tracked directory when no destination is given, so use the explicit arguments above. The [launchd counterexample](macos-launchd-README.md) needs an isolated script copy because it has no output argument. Exit **0** means listed checks passed, **1** means observed behavior violated requirements, and **2** means unavailable/unverifiable startup, capability or control. Missing prerequisites are not isolation success.

## What the Probes Establish

macOS canonicalizes both policy paths and executable paths, retaining a noncanonical `/tmp` counterexample. Each sensitive operation first proves the target accessible without a sandbox, then checks the sandbox child's own started marker and errno. The script creates its own TCP/Unix/Mach/IPC resources and target processes. Reports record read-only roots, policy, OS and outcomes; failure of one candidate does not disprove every Seatbelt policy.

The [preexisting-hardlink report](../../results/native-macos-preexisting-hardlink-report.md) has two real failures: a host-created hardlink from read-only/granted or shared Git content into the writable workspace allowed mutation of the original inode. Explicit denial of the original path did not prevent alias writes. Same inode, successful host control, sandbox startup and changed original bytes were independently verified; fixtures were cleaned. Denying creation of new hardlinks does not cover preexisting aliases. Product source assembly must reject unknown external aliases and read-only/writeable inode overlap separately.

Stopping tests prove a descendant is actively writing a heartbeat before stopping, then observe whether writes freeze. A missing main PID/job or successful kill is insufficient. The [macOS lifecycle fixture](macos-lifecycle-probe.py) covers original PGID, ordinary/TERM-ignoring descendants, Node detached, setsid, two posix_spawn attributes, short-lived intermediates, startup windows, abnormal parent exit, mode/grant changes and PID identity protection.

Receipts/heartbeats are independent controls, not the stop algorithm. The algorithm uses cumulative live process-tree observation, libproc uniqueid/birth time and a post-stop scan for new unknown same-UID orphans. Unknown orphans are not signaled: `UNVERIFIED` retains occupancy and blocks worker replacement. Concurrent external applications can create such orphans; observation interruption also retains occupancy. Signals use kernel-checked pidversion audit tokens; wrong pidversion must return ESRCH without killing the target.

Out-of-set posix_spawn descendants are separately reported as unverified with retained occupancy under the owner-accepted limit; correct safe handling does not mean they stopped. After recording the result, cleanup uses only this fixture's identity/unique argv and reports cleanup separately. It cannot rewrite the original stopping conclusion; occupancy markers and synthetic directories remain when required. Linux uses both PID namespace and independent user scope/cgroup reclamation.

## Historical Findings

- **2026-10-08, macOS 27.0 / Darwin 27.0.0 / arm64:** canonical path denials worked. posix_spawn setpgroup/setsid attributes bypassed syscall-denial assumptions; detached descendants kept writing after original-group stop. `kqueue NOTE_TRACK` returned ENOTSUP; launchd bootout also failed. See [Seatbelt](../../results/native-macos-report.md) and [launchd](../../results/native-macos-launchd.md).
- **2026-10-11, tx Ubuntu 24.04.4 / Linux 6.8.0-117-generic / x86_64:** installed `/usr/bin/bwrap` plus AppArmor supported complete namespaces. Seccomp also blocked pathname Unix sockets and socketpair sendto/sendmsg. The [current Linux report](../../results/native-linux-current-report.md) records 52 boundary checks plus two host controls passed, with system userns restrictions still enabled. The old unpacked `/tmp` binary's [35 unavailable checks](../../results/native-linux-report.md) and [weaker-policy failures](../../results/native-linux-namespace-only-report.md) remain unchanged.
- **2026-10-11, narrower macOS roots:** `/System/Library` plus `/Library/Developer/CommandLineTools` produced an 88/88 run, preserved in the [original log](../../results/native-macos-stage1-88-run.txt) and [recovered report](../../results/native-macos-stage1-88-recovered-report.md). Later runs overwrote original JSON/Markdown; missing metadata was not invented. This included Data-volume alias denials and three retained/reported real residues.
- Added hardlink-creation controls established host success, sandbox startup and EPERM. [Two 90-check runs](../../results/native-macos-stage1-concurrent-90-report.md) and a [quiet-window run](../../results/native-macos-stage1-quiet-census-report.md) yielded 89/90 and 88/90, not 90/90: concurrent same-UID orphans made some stopping unverified despite fixture exit/frozen heartbeats. The [main report](../../results/native-macos-stage1-report.md) retains the later failure.

The [initial 86-check report](../../results/native-macos-stage1-initial-report.md), [old 56-check report](../../results/native-macos-report.md) and [earlier concurrent report](../../results/native-macos-concurrent-report.md) retain their own results. The independent [Data-volume alias comparison](../../results/native-macos-system-data-alias-report.md) observed denials for canonical/alias reads/writes under broad/narrow policies, not an alias bypass. `missing=0` means all enumerated checks ran, not that product acceptance completed. macOS evidence is limited to 27.0/Darwin 27.0.0/arm64. PID tests cover mismatched birth identity and actual kernel pidversion denial, not forced PID wraparound.

These probes do not prove product read/edit/write/bash, approval consumption, delegation/worktrees/integration, grant-change rebuild or backend recovery. [Product smoke](../../../smoke/README.md) records these independently: ten worker and eight worktree checks per platform preceded native-only Coding production entry. Capability failure never authorizes local/unsandboxed fallback.
