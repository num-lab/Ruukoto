# Linux 原生沙箱前置

此目录提供 Ubuntu 24.04 的 bubblewrap 安装与 AppArmor 配置。`ruukoto-code` 正式入口默认且只接受 native，任务启动器不安装依赖或调整系统策略；原生启动失败报告不可用，不回退。

## 安装

由管理员在仓库根目录执行。先确认 `/etc/apparmor.d/ruukoto-bwrap` 不存在，且没有其他加载到 `/usr/bin/bwrap` 的同路径 profile；已有配置时先由管理员核对，避免覆盖。`sudo -n true` 检查是否可以无交互执行，失败时由管理员自行使用交互 sudo。

```bash
sudo apt-get install --no-install-recommends bubblewrap
test ! -e /etc/apparmor.d/ruukoto-bwrap && \
  sudo install -m 0644 deploy/native/ruukoto-bwrap /etc/apparmor.d/ruukoto-bwrap && \
  sudo apparmor_parser -r /etc/apparmor.d/ruukoto-bwrap
```

profile 按 `/usr/bin/bwrap` 匹配；临时目录中解包的副本不具备该权限。它允许该路径的 bwrap 创建 user namespace，实际执行限制仍由 bubblewrap 的挂载、网络、PID、IPC namespace 与 capability 删除提供。保留 `kernel.apparmor_restrict_unprivileged_userns=1`，不要关闭整机 userns 限制或给 bwrap 设置 setuid。

## 检查

以下命令分别确认二进制、profile、完整 namespace，以及 user systemd。profile 清单需要管理员权限；探针以实际开发用户运行。

```bash
/usr/bin/bwrap --version
sudo cat /sys/kernel/security/apparmor/profiles
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
systemctl --user is-system-running
systemd-run --user --scope --quiet true
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py --bwrap /usr/bin/bwrap
```

逐项结果、实际 namespace 标识与停止证据写到 `verification/foundation/results/native-linux-current-report.json` 和 `.md`。退出 2 表示缺能力或无法核实，不能记为通过。Linux 还须具备 cgroup v2、可创建 `Delegate=yes` 的 user scope，并能写该 scope 的 `cgroup.kill` 停止所有后代；完整检查的运行说明见[Linux 探针](../../verification/foundation/scripts/native-isolation/linux-README.md)。

## 从容器配置迁移

先用原入口停止 Coding Agent 后台与活动执行单元，核实退出后再替换检出并运行 `npm run setup`、`npm run build`。保留原 `~/.ruukoto-code`、工作副本、会话历史、审批、产物和待核实占用，不在线替换运行任务的环境。此处只调整执行后端配置；后台只接受当前 schema 的档案，不提供旧库升级或回填，启动前须按[操作手册](../../docs/usage.md)核实格式。

`--execution container` / `local` 与 `RUUKOTO_EXECUTION_BACKEND=container` / `local` 在正式 Coding Agent 入口明确拒绝；移除覆盖或显式改为 native。两个产品的完全访问均直接使用启动后台账户，不要求原生沙箱、容器或专用执行入口；个人产品的受限任务使用其配置的后端。入口与故障排查见[操作手册](../../docs/usage.md)。

## 移除

先停止使用原生沙箱的后台及执行单元，再卸载本目录安装的 profile。仅移除本次新增配置；管理员确认其他应用不依赖 bubblewrap 后才卸载包。

```bash
sudo apparmor_parser -R /etc/apparmor.d/ruukoto-bwrap
sudo rm /etc/apparmor.d/ruukoto-bwrap
sudo apt-get remove bubblewrap
```

这些操作不删除工作副本、会话历史、产物或审批记录。升级时同样先停旧后台，再启动新后台恢复现有任务与占用；不要在线替换活动任务的执行环境。

AppArmor 的按路径 userns 授权见 [AppArmor 官方说明](https://gitlab.com/apparmor/apparmor/-/wikis/unprivileged_userns_restriction)；scope 委派条件见 [systemd cgroup delegation](https://github.com/systemd/systemd/blob/main/docs/CGROUP_DELEGATION.md)。
