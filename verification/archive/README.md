# Historical Privileged Verification Source

This directory retains `.mts.txt` source referenced by historical release acceptance and the additional `.py.txt` preparation script. A complete clone can inspect them, but they are not current executable checks. Archived source bytes remain unchanged.

| Historical entry | Files and dependencies |
| --- | --- |
| Linux service management09 | `smoke-09-linux-service-management.mts.txt`, `smoke09-remote.mts.txt`, `smoke09-backendctl.mts.txt` |
| Standing operation permissions10 | `smoke-10-standing-permissions.mts.txt`, `smoke10-remote.mts.txt`, shared `smoke09-backendctl.mts.txt` |
| Linux full access24 | `release-24-linux-full-access.mts.txt` |
| Extra preparation for2026-10-06 joint acceptance | [release-24-prepare.py.txt](release-24-prepare.py.txt) |

The09/10 drivers bind to `ssh tx`, fixed remote `/tmp` paths, `rsync --delete`, existing `ruukoto-backend`/`ruukoto-exec` accounts and noninteractive sudo. Their raw remote scripts overwrite `/usr/local/libexec/ruukoto/ruukoto-service`, `/etc/ruukoto/services.json` and `/etc/sudoers.d/ruukoto`, using `/var/lib/ruukoto/service-ops`. Cleanup removes exercise backends/services/profiles but leaves helper, policy, sudoers and operation ledger in place. An isolated backend profile does not isolate those system resources.

The2026-10-06 record's system-path isolation/cleanup came from the extra preparation script. In an uploaded `ruukoto-release24-src-*` copy without `.git`, it rewrote helper/policy/ledger/sudoers/test-service paths and added their cleanup to09/10. That text remains byte-for-byte historical and depends on the original temporary layout, script contents and prerequisites. It is not a current safe execution entry and was not rerun during documentation migration.

The full-access script uses a temporary workspace/mock model but expects UID/GID986 and preinstalled sudo/systemd start/stop entries. It does not prepare or clean those entries.

Before restoring an executable gate, choose a disposable Linux host or independent system paths, provide account/fixed-entry/policy setup, verify exclusive target ownership before running, and restore/remove every system change created by the exercise. Distinguish pass, failure and unavailable prerequisites. **Do not rename these archives back to `.mts` and run them on a daily server.** Maintained rerunnable checks are in [smoke](../smoke/README.md).
