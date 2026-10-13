#!/bin/sh
# 仅在可销毁的隔离 VM 内运行；Node、依赖、检出和正式 bwrap/profile 须已准备。
set -eu
test -x /usr/bin/bwrap
test -f /etc/apparmor.d/ruukoto-bwrap
test -f /opt/ruukoto/reboot-worker.mts
native_uid=$(id -u ruukoto-native-check)
loginctl enable-linger ruukoto-native-check
install -d -m 0755 -o ruukoto-native-check -g ruukoto-native-check /var/lib/ruukoto-native-reboot-worker
cat > /etc/systemd/system/ruukoto-native-reboot-worker.service <<UNIT
[Unit]
Description=Isolated native worker after actual guest reboot
Requires=user@${native_uid}.service
After=user@${native_uid}.service
[Service]
Type=oneshot
User=ruukoto-native-check
Group=ruukoto-native-check
WorkingDirectory=/opt/ruukoto
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=XDG_RUNTIME_DIR=/run/user/${native_uid}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${native_uid}/bus
ExecStart=/usr/local/bin/node --import tsx reboot-worker.mts
KillMode=control-group
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ruukoto-native-reboot-worker.service
