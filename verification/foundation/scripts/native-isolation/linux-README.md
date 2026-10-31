# Linux Native Boundary Probes

`linux-native-probes.py` creates synthetic files, host TCP/Unix sockets, SysV/POSIX IPC and processes. It reads no real credentials and does not call the product launcher.

```bash
output="$(mktemp -d "${TMPDIR:-/tmp}/ruukoto-linux-probes.XXXXXX")"
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py \
  --bwrap /usr/bin/bwrap --output-dir "$output"
```

The script does not install bwrap or alter policy. See [administrator setup](../../../../deploy/native/README.md). Exit 0 means listed real boundaries passed, 1 means an observed mismatch, 2 means unavailable capability/control/probe. Unsandboxed controls first prove sensitive targets exist and are accessible. Without the sandbox child's started marker, checks are unavailable. Nested shell probes must report their own startup and errno: a missing command/interpreter is not isolation success. User-scope reclamation is independently recorded.

## Boundary Coverage

Read-only runtime roots include `/usr` and required `/bin`, `/sbin`, `/lib`, `/lib64`, not the whole host/HOME. `/etc/alternatives/cc` is a canonical symlink to an exposed compiler; binding the file would change GCC's own path and lose `cc1`. Workspace, explicit grants, child single-file access and shared Git directories mount separately. Tests cover symlink, parent and `/proc` aliases and compare device/inode identity with the host. Synthetic credential variables and FD100 test leakage; only the seccomp descriptor is inherited intentionally, rather than relying on bwrap to close an already inherited FD.

Network tests contact only script-created services: host loopback/interface, UDP, private/workspace pathname Unix sockets, abstract Unix sockets and socketpair datagrams. Seccomp denies `socket`, `connect`, `sendto`, `sendmsg`, `sendmmsg`, `io_uring_setup`, while preserving `socketpair` for Node child pipes. Wrong architecture/x32 calls reject, and unknown host architecture cannot start. Filter construction supports x86_64/aarch64; the cited real-OS evidence is x86_64, with aarch64 filter self-check only. user/mnt/net/pid/ipc/uts/cgroup namespaces are compared individually; IPC and host-PID tests use isolated resources.

## Stopping and Cleanup

Double-fork/setsid/TERM-ignoring descendants write heartbeats; tests include SIGKILL, startup windows and abnormal parent exit. Startup-window tests require the same sandbox Python to handshake ready before waiting for initialization; absent handshake cannot turn a zero-byte heartbeat into success. Unsandboxed controls prove ready→release starts writing and descendants survive parent exit.

Cleanup identifies this run's processes by unique argv path, host UID and start time, then pins them with stdlib pidfd before SIGKILL and verifies frozen heartbeats. Without pidfd, descendants are not started. Unverified cleanup retains temporary data. Controller/cleanup failure makes the whole run exit 2 even after all boundary rows have printed.

Mode-change controllers verify the old unit stopped before replacement. Narrowed grants must be inaccessible in the replacement. Independent reclamation uses `systemd-run --user --scope --property Delegate=yes`; the execution-reported cgroup must match its random unit before writing `cgroup.kill`. Before stop, detached descendants must still write inside that scope; afterward require frozen heartbeats, no probe processes and `populated 0` or removed/empty cgroup. This does not replace WorkerLauncher, approval or occupancy-recovery tests.

## Historical Results

On 2026-10-11, tx (Ubuntu 24.04.4 LTS, Linux 6.8.0-117-generic, x86_64, UID1003) used owner-approved bubblewrap 0.9.0-1ubuntu0.3 with `ruukoto-bwrap`; system userns restriction stayed enabled. The sandbox reported `ruukoto-bwrap (unconfined)`. The [report](../../results/native-linux-current-report.md) and [JSON](../../results/native-linux-current-report.json) record 52 real boundary checks plus two host controls passed, including Node children, C compilation and both whole-unit stop mechanisms. The recorded SHA256 identifies the script used.

The [2026-10-08 report](../../results/native-linux-report.md) and [JSON](../../results/native-linux-report.json) retain 35 unavailable checks: `/tmp` bwrap did not match the installed-path AppArmor profile. That is not evidence Ubuntu cannot support bwrap. The [namespace-only comparison](../../results/native-linux-namespace-only-report.md) retains four real failures for pathname socket, socketpair sendto/sendmsg and inherited FD, rather than relabeling them unavailable.

Rerun the weaker policy only as a failure control, never for product execution:

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py \
  --namespace-only --inherit-fixture-fd --output-dir "$(mktemp -d "${TMPDIR:-/tmp}/ruukoto-linux-baseline.XXXXXX")"
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py --self-check
```

Current and weaker-policy output filenames are separate (`native-linux-current-report` and `native-linux-namespace-only-report`, JSON/Markdown). Missing prerequisites permit no shared-network/local/Docker/backend-account fallback. Product integration acceptance remains necessary.
