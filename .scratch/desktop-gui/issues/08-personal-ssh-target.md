# Personal 目标：SSH 转发与令牌读取

Status: plan-review

## 目标与边界

实现[规格 R15 与 R20 中的远程使用说明](../spec.md)：主进程能经 SSH 转发连接服务器上的 ruukoto，连接状态与 Code 目标并存。界面在 09。

## 方案

1. 连接目标配置增加 Personal：ssh 主机别名与远端控制目录（默认 `/var/lib/ruukoto/control`），保存在应用数据目录；不保存令牌。
2. 建连：先用 `ssh -o BatchMode=yes <host> cat <控制目录>/owner.token` 读令牌到内存；再启动规格 R15 的 `ssh -N … -L` 转发，本地 socket 放在 0700 目录；转发就绪后交给 `ControlConnection`，并按显式产品 `ruukoto` 处理 `product_mismatch`。
3. ssh 进程退出或转发失败时，按 `ControlConnection` 的退避策略重启 ssh 并重新读取令牌；需要交互认证时显示明确错误，不重试刷屏。
4. 文档：修订 `docs/modules/tui.md` 与 `docs/usage.md` 的远程使用说明；`docs/modules/desktop.md` 补充 Personal 目标。

## 进展与交接

- 当前：方案已经拥有者确认，待独立方案审查；实现未开始。
- 下一步：方案审查者核对服务器上 socket（0660）与控制目录（0700）对拥有者登录账户的可达性，以及 `StreamLocalBindUnlink` 在本机残留 socket 时的行为。
- 基点：`develop` @ `4611eff`。依赖 03；可在 04–07 之后排期。
- 阻塞：03 未完成。

## 验收与证据

工程待验证。单测：两条 ssh 命令的参数拼接、本地 socket 目录权限、退避重启的状态机。

人工检查（外部验收，需要真实服务器）：连上服务器后看到快照；杀掉 ssh 进程后自动恢复；应用数据目录中没有令牌；远端令牌更换后，下次建连可用；需要密码的主机显示明确错误。缺服务器时记为不可验证。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。
