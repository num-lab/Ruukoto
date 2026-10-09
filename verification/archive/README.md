# 历史特权验收源码

这里保存发布验收引用的六份 `.mts.txt` 源码，以及额外准备过程的 `.py.txt` 文本，供完整 clone 审阅历史证据。它们不属于当前可执行验证入口，内容按原记录保留。

| 发布记录中的入口 | 归档文件与依赖 |
| --- | --- |
| Linux 服务管理 09 | `smoke-09-linux-service-management.mts.txt`、`smoke09-remote.mts.txt`、`smoke09-backendctl.mts.txt` |
| 长期操作授权 10 | `smoke-10-standing-permissions.mts.txt`、`smoke10-remote.mts.txt`，共用上述 `smoke09-backendctl.mts.txt` |
| Linux 完全访问 24 | `release-24-linux-full-access.mts.txt` |
| 2026-10-06 联合验收的额外准备 | [release-24-prepare.py.txt](release-24-prepare.py.txt) |

09/10 驱动绑定 `ssh tx`、固定的远端 `/tmp` 目录、`rsync --delete`、既有 `ruukoto-backend` / `ruukoto-exec` 账户与无交互 sudo。远端原始脚本直接覆盖 `/usr/local/libexec/ruukoto/ruukoto-service`、`/etc/ruukoto/services.json` 和 `/etc/sudoers.d/ruukoto`，使用 `/var/lib/ruukoto/service-ops`。清理仅移除演练后台、测试服务和演练档案，helper、策略、sudoers 与操作账本按原脚本保留。原始脚本中的隔离后台不能保证系统部署资源也已隔离。

2026-10-06 联合验收记录中的系统路径隔离和清理，来自上述额外准备过程：它在无 `.git`、名称为 `ruukoto-release24-src-*` 的上传副本中改写 helper、策略、账本、sudoers 和测试服务路径，并给 09/10 加入这些独立资源的清理。该文本按原字节归档，仍依赖当时的临时目录布局、原始脚本内容与系统前提；它没有成为当前安全运行入口，也未在本轮执行。

完全访问脚本使用临时工作区和 mock 模型，但固定断言执行 uid/gid 为 986，并依赖已经安装的 sudo/systemd 启动与停止入口；它没有包含这些入口的准备和清理。

重新建立可执行门禁前，需要选定一次性 Linux 测试主机或独立系统路径，提供账户、固定启动入口和策略的准备步骤，执行前核实目标资源独占，清理时恢复或移除本次系统改写，并分别报告通过、失败与前提缺失。禁止将这些归档直接改回 `.mts` 后在日常服务器运行。已可复跑的验证见 [../smoke/README.md](../smoke/README.md)。
