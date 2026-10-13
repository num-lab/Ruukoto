#!/bin/sh
set -eu
unit=ruukoto-native-reboot-worker.service
profile=/etc/apparmor.d/ruukoto-bwrap
restore() {
  if test -e /usr/bin/bwrap.stage1-disabled; then mv /usr/bin/bwrap.stage1-disabled /usr/bin/bwrap; fi
  if test -e "$profile.stage1-disabled"; then mv "$profile.stage1-disabled" "$profile"; fi
  apparmor_parser -r "$profile"
}
trap restore EXIT INT TERM
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
apparmor_parser -R "$profile"
mv "$profile" "$profile.stage1-disabled"
if systemctl start "$unit"; then printf 'ERROR missing profile accepted\n'; exit 1; fi
journalctl -u "$unit" --no-pager -n 30
restore
mv /usr/bin/bwrap /usr/bin/bwrap.stage1-disabled
if systemctl start "$unit"; then printf 'ERROR missing bwrap accepted\n'; exit 1; fi
journalctl -u "$unit" --no-pager -n 30
restore
systemctl reset-failed "$unit"
printf 'PREREQUISITE_REFUSALS_COMPLETED\n'
