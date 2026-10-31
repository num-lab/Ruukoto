# Personal Server Deployment (Linux)

Pi durable owns production Personal state; its CLI manages the same backend. Full access uses the actual backend account's existing authority. These instructions create a new profile. Taking over an old backend, profile or production channel requires the separate upgrade procedure. Coding's local TUI, protocol and profile remain unchanged.

<!-- Note: See .agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md -->

## Installation

This example installs the complete workspace at `/opt/ruukoto` and a new profile at `/var/lib/ruukoto/personal-durable`, using an existing ordinary account. Prepare Node ≥24.15, Git, Bash, coreutils, Python 3 and dbus-user-session, plus [native prerequisites](../native/README.md) for commands. Substitute actual account, UID and Node path. Inspect ownership of any existing unit, checkout or profile; do not overwrite a running deployment. Execute step by step and stop on failure.

```bash
# 1. New profile and complete workspace; verify destinations are not occupied by old data.
run_user=$(id -un)
run_group=$(id -gn)
run_uid=$(id -u)
node_bin=$(node -p 'process.execPath')
"$node_bin" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(!(major>24||(major===24&&minor>=15)))process.exit(1)'
test ! -e /var/lib/ruukoto/personal-durable
sudo install -d -o "$run_user" -g "$run_group" -m 0700 /var/lib/ruukoto/personal-durable
sudo rsync -a --delete --exclude node_modules --exclude .git --exclude .DS_Store ./ /opt/ruukoto/
sudo env PATH="$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin" sh -c 'cd /opt/ruukoto && npm ci --omit=dev && npm run build'

# 2. Configure as the runtime account; credentials come from this terminal's environment.
RUUKOTO_PERSONAL_DIR=/var/lib/ruukoto/personal-durable \
  "$node_bin" /opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs
# Configure models, dedicated test IM, sources and services; then stop the backend in the menu.

# 3. Keep the user manager available after logout and boot.
sudo loginctl enable-linger "$run_user"
sudo systemctl start "user@$run_uid.service"
sudo -u "$run_user" env XDG_RUNTIME_DIR="/run/user/$run_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$run_uid/bus" systemctl --user is-system-running

# 4. Substitute the actual identity and Node path before installing the template.
python3 - "$run_user" "$run_group" "$run_uid" "$node_bin" <<'PYCODE' | sudo tee /etc/systemd/system/ruukoto-backend.service >/dev/null
from pathlib import Path
import sys
text = Path("deploy/systemd/ruukoto-backend.service").read_text()
for name, value in zip(("RUN_USER", "RUN_GROUP", "RUN_UID", "NODE_BIN"), sys.argv[1:]):
    text = text.replace("@" + name + "@", value)
print(text, end="")
PYCODE
```

Systemd does not inherit an interactive shell. Supply the environment variables named by model/IM configuration through a root-protected `EnvironmentFile` or existing secret manager before starting. Such files contain assignments, not shell commands; do not put secrets in unit text, argv or the repository. Do not copy old `agent/` configuration/tokens. Explicitly supply any required proxy/SSH-agent environment. Verify command scopes and stopping as the actual service account in the same environment.

After the new profile and dedicated test entries are ready:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ruukoto-backend
RUUKOTO_PERSONAL_DIR=/var/lib/ruukoto/personal-durable \
  "$node_bin" /opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs
```

The template runs `serve --directory /var/lib/ruukoto/personal-durable`; an explicit absolute directory wins over environment. SIGTERM/SIGINT/SIGHUP close entries and Harness before exit. Daily menu exit does not stop the independent backend. The profile has its own SQLite, `0700` directories, `0600` configuration/log/token files and authenticated socket; it does not use legacy `RUUKOTO_DATA_DIR/AGENT_DIR/CONTROL_DIR` or owner tokens. A standalone app tarball is not a substitute for the complete workspace and built worker dependencies.

## Desktop Settings Maintenance

Desktop chat, models, skills and MCP share one Tailscale HTTPS origin. Root-managed Tailscale Serve terminates TLS and proxies a private Unix socket. A separate same-account `ruukoto-remote.service` owns authentication/maintenance and can inspect/recover while the backend is stopped. Desktop no longer executes SSH; administrator SSH remains separate. Use only the private tailnet, never Funnel.

The fixed backend unit must use the installed Node/bin and `serve --directory`, `Type=simple`, `SendSIGKILL=no`, `TimeoutStopFailureMode=terminate`, `KillMode=control-group`, `KillSignal=SIGTERM`, and no additional ExecStop/ExecStopPost. An administrator must daemon-reload changed units. Stop timeout retains backend and lock: do not continue saving or force-kill. `TimeoutStopFailureMode=abort` is unsupported even with SIGKILL disabled.

Install only exact start/stop authority for that unit, after substituting and checking the account:

```bash
sed "s/@RUN_USER@/$run_user/g" deploy/systemd/sudoers.d.ruukoto-settings > /tmp/ruukoto-settings.sudoers
sudo visudo -cf /tmp/ruukoto-settings.sudoers
sudo install -o root -g root -m 0440 /tmp/ruukoto-settings.sudoers /etc/sudoers.d/ruukoto-settings
sudo -n -l /usr/bin/systemctl start ruukoto-backend.service
sudo -n -l /usr/bin/systemctl stop ruukoto-backend.service
```

No wildcards, extra arguments or arbitrary commands are granted. The existing service helper still rejects the backend itself. Remote uses the same account and this exact authorization; GUI installs neither permissions nor units and becomes read-only when prerequisites are missing. Validate in an isolated deployment, not by taking over a same-named production unit. Maintenance does not read/copy the service's EnvironmentFile.

Verify Tailscale version, tailnet and HTTPS prerequisites; isolated probes used 1.104.2. Root manages Serve's socket proxy; do not make the service account a Tailscale operator. Access policy must allow the fixed owner to the PA node on TCP443 without a wider rule negating the restriction. On a single-owner tailnet, replace the broad grant's source with the actual owner login. Certificate names enter public certificate-transparency logs; that does not make the service public.

As the runtime account, open the local remote wizard and initialize the binding using the complete HTTPS origin, fixed Tailscale login and existing durable profile. The program manages IDs/tokens and fixed service names. Initialization persists a new remote identity and empty maintenance ledger. Corrupt existing authentication is not overwritten; explicitly reinstalling missing state creates a new identity. Stop remote during initialization/binding changes; PA itself can keep running.

```bash
sudo -H -u "$run_user" "$node_bin" /opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs remote
sed -e "s|@RUN_USER@|$run_user|g" -e "s|@RUN_GROUP@|$run_group|g" -e "s|@NODE_BIN@|$node_bin|g" deploy/systemd/ruukoto-remote.service > /tmp/ruukoto-remote.service
sudo install -o root -g root -m 0644 /tmp/ruukoto-remote.service /etc/systemd/system/ruukoto-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now ruukoto-remote.service
remote_home=$(getent passwd "$run_user" | cut -d: -f6)
remote_socket="$remote_home/.config/ruukoto-remote/remote.sock"
sudo tailscale serve --bg "unix:$remote_socket"
sudo tailscale serve status --json
```

Publish only `remote.sock`, never `admin.sock`; the directory is `0700`, files/sockets `0600`. `remote serve` creates no Harness and accepts no arbitrary profile/program/unit/command. Foreground diagnosis uses `ruukoto remote serve`, never concurrently with the fixed remote service on the same root.

Reopen `ruukoto remote`, enable desktop pairing and enter the one-time, five-minute code in PA remote settings. The desktop asks only for origin/code; it securely saves and reads back long-lived credentials before registration, never exposing the backend token. Electron/MyGo have separate stores and credentials. Human-readable labels identify devices for revocation. Revocation blocks new admission/closes streams but accepted work continues. Lost desktops can be revoked/re-paired on the server. Locked, denied, corrupt or unavailable OS storage must be repaired, never bypassed with plaintext or network identity alone.

Remote records maintenance intent, phases and receipts before side effects. Accepted work survives desktop closure. After lost replies/restart, query the original key instead of replaying a save. A saved revision with startup failure remains saved; explicit restore only verifies/starts the original service. Pending records block replacement; an old A request arriving after completed A and B returns A's receipt. Protected `auth.json`, `remote.json`, `maintenance.json` and lock files live under `~/.config/ruukoto-remote/`; missing/corrupt state keeps the entry closed. Preserve and recover consistent records rather than deleting a ledger to clear pending work.

Changing owner, origin or profile identity persistently revokes old credentials before local confirmation of the new binding; reverting values does not revive them. Close old desktops and verify each original maintenance record before switching. Old `personal.json`, `personal-settings.json` and pending state remain in place; successful new connection does not prove old maintenance completed. Software rollback preserves current profile data instead of overwriting it with an old backup.

`ruukoto maintenance` accepts stdin `{v:1,op:"inspect",lifecycle:"systemd",program:"/opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs"}` and uses settings-style product/version/error output. Read the original `profile` first; explicit stop/start returns that same identity. There are no arbitrary service actions. Unverifiable CLI startup environments are read-only; managed development belongs to its launcher. After a stop/save/start lost response, query original configuration/service first and explicitly restore only when the original service is stopped. Do not automatically resave or roll back.

## Upgrade and Rollback

Moving legacy Personal to durable is a blank-instance cutover. Use the old version to stop scheduler/outbox, IM, backend and independent execution units; disable its automatic service restart and verify every original identity exited. `KillMode=control-group` covers only that unit, not separate user scopes. Unverified stopping blocks cutover and retains occupancy/evidence.

Keep old profiles, code/dependency versions and a protected consistent backup/manifest in place. Never move/overwrite/delete committed conversations or start an old backend merely to read archives: it may resume work or send. Configure a separate empty durable directory with fresh models, credentials, platform bindings and services. Old history, memory, business data, schedules, approvals and work are not imported; legacy control, development conversations, workflows and GitHub auto-review are not wired into Personal.

Production cutover requires separate final acceptance: verify old receivers/senders stopped, record platform watermarks/pairing boundaries and filter old backlog/redelivery. The owner resubmits work not accepted during the pause. A successful build/isolated probe does not authorize production bots/accounts/services. Later durable upgrades likewise stop/verify original execution and preserve full profile/unknown-effect records. Unknown versions reject; do not hand-edit formats.

Rollback first stops/verifies new execution and archives both profiles. Roll back code only; an old version uses another empty profile with fresh configuration/platform boundaries, not restored old queues/sends/schedules. External side effects are not undone. Never run two consumers for one platform. Coding upgrades remain separate.

## Server Service Management

With Personal stopped, its menu saves absolute helper/policy/sudo paths; models cannot change them. Durable retains original identity, authority and receipts for main/child inspection, child restarts and host operations. Full access omits per-operation approval; other modes use original-IM approval or an exact standing grant. Missing helper/sudo fails without arbitrary-root fallback.

```bash
# 1. Root-owned fixed helper, policy and operation directory.
sudo install -d -m 0755 /etc/ruukoto /usr/local/libexec/ruukoto
sudo install -d -m 0700 /var/lib/ruukoto/service-ops
sudo install -m 0700 deploy/systemd/ruukoto-service.mjs /usr/local/libexec/ruukoto/ruukoto-service
sudo install -m 0644 /dev/stdin /etc/ruukoto/services.json <<JSON
{
  "machineId": "$(cat /etc/machine-id)",
  "inspectUid": $(id -u),
  "inspectGid": $(id -g),
  "services": { "ruukoto-service-test.service": { "actions": ["restart"] } }
}
JSON
sed "s/@RUN_USER@/$(id -un)/g" deploy/systemd/sudoers.d.ruukoto | sudo tee /etc/sudoers.d/ruukoto >/dev/null
sudo chmod 0440 /etc/sudoers.d/ruukoto
sudo visudo -cf /etc/sudoers.d/ruukoto

# 2. Controlled test service: ordinary account, no network/secrets, Restart=no.
sudo install -m 0755 deploy/systemd/ruukoto-service-test.sh /usr/local/libexec/ruukoto/ruukoto-service-test.sh
sed -e "s/@RUN_USER@/$(id -un)/g" -e "s/@RUN_GROUP@/$(id -gn)/g" deploy/systemd/ruukoto-service-test.service | sudo tee /etc/systemd/system/ruukoto-service-test.service >/dev/null
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0750 /var/lib/ruukoto-service-test
sudo systemctl daemon-reload
sudo systemctl start ruukoto-service-test

# 3. Stop Personal, then configure the same new profile's service paths in its menu:
# helper: /usr/local/libexec/ruukoto/ruukoto-service
# policy: /etc/ruukoto/services.json
# sudo: /usr/bin/sudo
# Save and restart Personal; configuration does not install/restart target services.
```

`inspect` runs `systemctl show` as the policy's non-root inspection UID/GID. `restart` runs fixed `systemctl restart` in a root transient command unit; `stop-op` stops only that operation unit. [Deployment design](../../docs/modules/deploy.md) covers revisions and uncertain effects. Exit code zero does not prove business health; cancellation does not undo a restart job already submitted to PID 1.

`inspect-op`/`stop-inspect` persist identity for durable fixed inspection. The caller pre-records machine/inspection ownership and creates an independent process group; sudo supervisor/helper may share it. Updating the helper does not automatically enable the feature or broaden sudoers.

Exercise cleanup removes only resources created for that exercise: service, launcher, state, policy entries and helper drop-ins. Production cleanup requires owner verification. See [historical acceptance](../../docs/release-acceptance.md#historical-verification).
