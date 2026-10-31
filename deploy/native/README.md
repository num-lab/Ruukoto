# Linux Native Sandbox Prerequisites

This directory supplies Ubuntu 24.04 bubblewrap/AppArmor configuration. Coding restricted execution and Personal Linux commands use native boundaries. Task launchers neither install dependencies nor change system policy; unavailable native execution fails without fallback. Configure Personal service identity, persistent user manager and environment using [server deployment](../systemd/README.md).

## Install

An administrator runs these commands from the repository root. First verify `/etc/apparmor.d/ruukoto-bwrap` does not exist and no other loaded profile owns `/usr/bin/bwrap`; review existing configuration instead of overwriting it. `sudo -n true` checks noninteractive authority; if it fails, the administrator must perform interactive sudo themselves.

```bash
sudo apt-get install --no-install-recommends bubblewrap
test ! -e /etc/apparmor.d/ruukoto-bwrap && \
  sudo install -m 0644 deploy/native/ruukoto-bwrap /etc/apparmor.d/ruukoto-bwrap && \
  sudo apparmor_parser -r /etc/apparmor.d/ruukoto-bwrap
```

The profile matches `/usr/bin/bwrap`, not a copy unpacked under `/tmp`. It allows user-namespace creation; bubblewrap mounts, network/PID/IPC namespaces and dropped capabilities impose the actual boundary. Keep `kernel.apparmor_restrict_unprivileged_userns=1`; neither disable machine-wide userns restrictions nor make bwrap setuid.

## Verify

Check the binary, loaded profile, complete namespace setup and user systemd. Profile listing needs administrator access. Run probes as the actual developer/backend account with the deployed runtime directory and user bus; a successful login-shell probe does not prove system-service readiness.

```bash
/usr/bin/bwrap --version
sudo cat /sys/kernel/security/apparmor/profiles
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
systemctl --user is-system-running
systemd-run --user --scope --quiet true
output="$(mktemp -d "${TMPDIR:-/tmp}/ruukoto-native-probes.XXXXXX")"
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py --bwrap /usr/bin/bwrap --output-dir "$output"
```

Results, namespace identities and stopping evidence go to `$output/native-linux-current-report.{json,md}`. Keep new evidence outside the checkout; tracked reports are historical and must not be overwritten. Exit 2 means unavailable/unverifiable, not pass. Linux also needs cgroup v2, a `Delegate=yes` user scope and writable `cgroup.kill` to stop all descendants; see [Linux probes](../../verification/foundation/scripts/native-isolation/linux-README.md).

## Migrate from Container Configuration

Stop the old backend with its own version and verify every original execution unit has exited. If stopping is unverified, preserve occupancy/evidence and stop the migration. Then back up configuration/profile, replace the checkout, install dependencies and run `npm run build`. Retain work copies, JSONL, approvals, artifacts and unresolved occupancy. Never replace an active task's environment online. Follow [upgrade and rollback](../systemd/README.md#upgrade-and-rollback) for Personal.

The current Coding core accepts its current schema and does not provide old-schema backfill; use the documented import path where applicable. Moving Personal to durable requires a separately configured blank profile; old data is archived, not imported or resumed.

Coding rejects `--execution container`/`local` and corresponding `RUUKOTO_EXECUTION_BACKEND` values. Remove the override or choose native, and remove obsolete worker-image/container-UID/GID settings. New Personal does not read those legacy parameters; configure commands through its menu. Full access uses the backend account directly and does not require a native sandbox, container or dedicated privileged entry.

Native temporary HOME/TMPDIR uses host storage, without the old container `/tmp` 64 MiB cap. Cleanup follows verified stopping; unverified units retain their directories.

## Remove

First stop backends and execution units using the sandbox. Remove only the profile installed by this setup. Uninstall bubblewrap only after the administrator verifies no other application needs it.

```bash
sudo apparmor_parser -R /etc/apparmor.d/ruukoto-bwrap
sudo rm /etc/apparmor.d/ruukoto-bwrap
sudo apt-get remove bubblewrap
```

These commands do not remove work copies, history, artifacts or approvals. Preserve those during upgrades as well.

References: [AppArmor userns restrictions](https://gitlab.com/apparmor/apparmor/-/wikis/unprivileged_userns_restriction), [systemd cgroup delegation](https://github.com/systemd/systemd/blob/main/docs/CGROUP_DELEGATION.md).
