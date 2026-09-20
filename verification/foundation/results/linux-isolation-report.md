# Linux 受限执行探针报告

- 时间：2026-09-20T09:29:10
- 宿主: Darwin 27.0.0
容器引擎: Docker version 29.4.1, build 055a478
- 容器环境：Linux 6.12.76-linuxkit / NAME="Debian GNU/Linux"
- 注意：本次在 Docker Desktop（macOS 上的 Linux VM）中验证容器边界本身；
  目标 Linux 服务器的宿主前提（发行版、内核、rootless 运行时）未验证，见 issue 记录。

| 探针 | 预期 | 结果 | 说明 |
| --- | --- | --- | --- |
| subprocess.capabilities | info | 00000000a80425fb | 默认容器能力位（记录用） |
| workspace.write | pass | pass | touch /workspace:  |
| hostfs.absent:/Users | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/home/eitrous | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/root/.pi | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/etc/ruukoto-backend | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/var/run/docker.sock | fail | fail | 宿主路径在容器内不可见 |
| rootfs.write-outside-workspace | pass | pass | root 容器可写容器层（宿主隔离见 hostfs.absent.*） |
| credentials.env-clean | pass | pass | 环境变量无凭据 |
| credentials.no-pi-config | fail | fail | 容器内无 ~/.pi 配置与凭据 |
| subprocess.spawn | pass | pass | subprocess-ok |
| subprocess.mount-denied | fail | fail | mount: /mnt: permission denied.        dmesg(1) may have more information after failed mount system call. |
| control-plane.loopback-not-reachable | fail | fail | 宿主回环监听的控制面端口从容器不可达 |
| control-plane.gateway-loopback-service | fail | fail | 网关 172.17.0.1:18973 不可达（宿主只绑回环时的预期） |
| workspace.write | pass | pass | touch /workspace:  |
| hostfs.absent:/Users | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/home/eitrous | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/root/.pi | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/etc/ruukoto-backend | fail | fail | 宿主路径在容器内不可见 |
| hostfs.absent:/var/run/docker.sock | fail | fail | 宿主路径在容器内不可见 |
| rootfs.write-outside-workspace | fail | fail | touch: cannot touch '/etc/escape-write': Permission denied |
| credentials.env-clean | pass | pass | 环境变量无凭据 |
| credentials.no-pi-config | fail | fail | 容器内无 ~/.pi 配置与凭据 |
| subprocess.spawn | pass | pass | subprocess-ok |
| subprocess.capabilities-zero | pass | pass | CapEff=0000000000000000 |
| subprocess.mount-denied | fail | fail | mount: /mnt: must be superuser to use mount.        dmesg(1) may have more information after failed mount system call. |
| network.egress-blocked | fail | fail | --network none 下外网 1.1.1.1:443 不可达 |
| control-plane.loopback-not-reachable | fail | fail | 宿主回环监听的控制面端口从容器不可达 |
| workspace.host-secret-absent | fail | pass | 宿主真实存在的 $WORK/host-only-secret.txt 在容器内不可见（边界生效，非目标不存在） |
| identity.root-reads-own-state | pass | pass | root 可读自己的状态文件（对照：文件真实可读） |
| identity.task-uid-reads-backend-state | fail | pass | uid 1000 读取控制面状态被内核拒绝（EACCES） |
| identity.task-uid-writes-backend-state | fail | pass | uid 1000 写控制面状态被内核拒绝（EACCES） |
