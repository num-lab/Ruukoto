#!/bin/sh
set -eu
mkdir -p /mnt/host /opt/ruukoto/node_modules
mountpoint -q /mnt/host || mount -t 9p -o trans=virtio,version=9p2000.L,ro ruukoto-share /mnt/host
mountpoint -q /opt/ruukoto/node_modules || mount --bind /mnt/host/repo/node_modules /opt/ruukoto/node_modules
cp /mnt/host/repo/verification/smoke/smoke-27-native-service.mts /opt/ruukoto/verification/smoke/smoke-27-native-service.mts
printf 'ruukoto-share /mnt/host 9p trans=virtio,version=9p2000.L,ro 0 0\n/mnt/host/repo/node_modules /opt/ruukoto/node_modules none bind,ro,x-systemd.requires=mnt-host.mount 0 0\n' >> /etc/fstab
mkdir -p /var/lib/ruukoto-native-service-smoke
chown ruukoto-native-check:ruukoto-native-check /var/lib/ruukoto-native-service-smoke
native_uid=$(id -u ruukoto-native-check)
loginctl enable-linger ruukoto-native-check
cat > /etc/systemd/system/ruukoto-native-stage1.service <<UNIT
[Unit]
Description=Isolated ruukoto native service verification
Requires=user@${native_uid}.service
After=user@${native_uid}.service
RequiresMountsFor=/opt/ruukoto/node_modules
[Service]
Type=simple
User=ruukoto-native-check
Group=ruukoto-native-check
WorkingDirectory=/opt/ruukoto
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=XDG_RUNTIME_DIR=/run/user/${native_uid}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${native_uid}/bus
ExecStart=/usr/local/bin/node --import tsx verification/smoke/smoke-27-native-service.mts service /var/lib/ruukoto-native-service-smoke
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ruukoto-native-stage1.service
uname -a
cat /etc/os-release
cat /proc/sys/kernel/random/boot_id
loginctl show-user ruukoto-native-check -p Linger -p Sessions -p State
systemctl show ruukoto-native-stage1.service -p MainPID -p User -p ControlGroup
