# macOS launchd Descendant-Reclamation Probe

`macos-launchd-probe.py` tests whether launchd bootout reclaims descendants that left the original process group. It is a historical lifecycle candidate, not product integration or a complete filesystem/network/credential/IPC policy test.

Run on real macOS with the current user's GUI launchd domain, host Node, `/usr/bin/python3`, `sandbox-exec` and `launchctl`:

```bash
probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ruukoto-launchd.XXXXXX")"
mkdir -p "$probe_root/scripts/native-isolation"
cp verification/foundation/scripts/native-isolation/macos-launchd-probe.py "$probe_root/scripts/native-isolation/"
python3 "$probe_root/scripts/native-isolation/macos-launchd-probe.py"
```

The isolated copy writes reports to `$probe_root/results/native-macos-launchd.{json,md}`. This legacy script has no output argument; running the checkout copy would overwrite tracked historical reports. Preserve the external result instead. Exit 2 means missing capability, startup/control failure or unverified cleanup; 1 means stopping failed under a valid running control; 0 requires both lifecycle checks to pass.

The probe creates only its unique temporary GUI job with `RunAtLoad=true`, `KeepAlive=false`, `ExitTimeOut=1`, `AbandonProcessGroup=false`. sandbox-exec applies a network-denial-only test policy. Python `start_new_session=True` and Node `detached:true` create TERM-ignoring descendants writing synthetic heartbeats, with a 20-second self-stop limit.

Before stop, prove actual descendant activity. Afterward inspect job removal, parent exit, descendant liveness and heartbeat changes. Cleanup touches only this job and signals a captured PID only after its argv matches the unique temporary directory, then verifies exit/frozen heartbeat. A started parent without child-spawn receipt, or unverifiable cleanup, retains temporary data rather than hiding residue by deleting heartbeats.

On 2026-10-08, macOS 27.0/Darwin 27.0.0/arm64/Node24.15.0, both controls were valid and both stopping paths failed: bootout returned 0, job query 113 and parents exited, but detached descendants kept writing. All captured processes/jobs were eventually cleaned. This rejects that launchd candidate, not every privileged native-management approach, and does not establish completion of the native replacement.
