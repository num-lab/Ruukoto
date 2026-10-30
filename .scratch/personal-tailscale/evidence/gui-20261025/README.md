# 双壳实际配对、聊天与重开

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

拥有者于2026-10-25明确许可启动两个完整Acceptance应用、切换测试窗口与可能出现的Keychain授权。实际操作只针对独立应用名称、数据目录和Linux隔离档案；没有打开正式Ruukoto、读取正式凭据或停止生产PA。界面经macOS AX与已授权的鼠标/按键操作，没有CDP、外部renderer、调试端口或诊断注入。

## 已完成的实际检查

| 检查 | Electron | MyGo |
| --- | --- | --- |
| 正常界面填写同一HTTPS地址、短码配对 | 通过，真实异步safeStorage | 修复sidecar打包后通过，真实Go Keychain与私有帧 |
| 长期秘密不经操作工具输入 | 仅输入短码与桌面名称 | 仅输入短码与桌面名称 |
| 文本及最终答案显示 | `electron-chat-complete.png` | `mygo-chat-complete.png` |
| 正常退出后重开，无需再次配对 | `electron-reopen-restored.png` | `mygo-reopen-restored.png` |
| 原凭据未增加或更换 | 私有admin列表前后相等 | 私有admin列表前后相等 |
| 退出回收 | 主进程及helpers消失 | 主进程及Node sidecar消失，独立于AppleEvent返回值核实 |

Electron标记为 `TS GUI Electron acceptance 20261025 xh6h6fsy`，MyGo标记为 `TS GUI MyGo acceptance 20261025 xh6h6fsy`。[服务器只读结果](server-markers.json)按各标记SHA核实：分别一份user entry、一份done提交和一份stop/terminal最终答案；两条输入没有重发。`server-after-electron.json`保留中间时点MyGo尚未发送、顶层verified=false的事实，不把它冒充最终通过。

[重开核实](credential-reopen-results.json)保存精确凭据ID、退出前后PID与密文元数据；不含秘密或密文。`processes-before-quit.log`仅采集pid/ppid/comm，`processes-after-quit.json`核实最后两壳和跟踪sidecar均不存在。MyGo正常AppleEvent退出返回“User canceled (-128)”，实际进程随后退出；没有用命令返回值代替退出事实，也没有强杀。

Electron另只读打开模型、Skills、MCP，三页显示同一 `/var/lib/rktest/profile` 在线，见三张设置截图。没有测试真实提供方、导入技能、写设置或启动真实沙箱。切页出现的忙提示单独修复与复验，不把手工重读后的画面当作原切页已通过。

## 实际失败与修复

`mygo-first-start-failed.png`保留首次MyGo界面连接不可用。签名制品的原sidecar在装载已打包ws时执行 `require("events")`，ESM没有require而退出，尚未调用凭据存储。修复只为Node内置模块提供require，拒绝从应用外解析可选扩展。真实bundle私有管道回归7/7通过；独立松绑对照实际加载两个伪造扩展并使断言失败，见[独立复核](mygo-bundle-independent-review.json)及[源码/结果](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-tailscale%2Fevidence%2Fgui-20261025%2Fmygo-bundle-review-source-and-results.tar.gz)。

MyGo在原路径单独重建并重新核实签名、固定Node摘要和隔离service，未重建或替换已测Electron；新制品元数据在 `artifacts-mygo-builtin-fix.json`，复现补丁在 `mygo-builtin-fix-on-source-snapshot.patch`。根正式MyGo重建通过，`static-after-bundle-fix.log`对应随后完整静态检查。

测试中公网SSH短暂返回Connection closed；改用同节点tailnet IP和原公钥校验后恢复本机管理，没有更改sshd或跳过host key校验。第一次撤销尝试没有收到响应，后来只读确认仍active；重新按同一测试ID执行后服务器明确revoked，Electron保留历史、显示明确撤销原因并禁用发送，见 `electron-revocation.json`。此事实不等于Tailscale策略或设备撤销验收。

设置切页的失败另由真实React与Radix最小夹具复现：前页已显示数据后，旧panel在卸载前因pageKey变化先重挂并读取，新页相同完整view读取被误报management_busy。修复按在途promise合并同档案read，成功/失败后清理，关闭后拒绝新读取；其他查询与维护写入继续互斥。根[设置定向检查](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-tailscale%2Fevidence%2Fgui-20261025%2Fsettings-tests.log)36/36通过，原始红绿与可复跑夹具见[源码/结果](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-tailscale%2Fevidence%2Fgui-20261025%2Fsettings-page-read-source-and-results.tar.gz)。

最终签名MyGo已在原Keychain记录上复验模型→Skills→MCP直接切页，三个页面首次加载成功，没有点击重新读取，见两张 `mygo-settings-direct-*` 截图及 `settings-direct-results.json`。更新后的应用仍读回原凭据并恢复原历史，未观察到系统授权框；这是本次更新的观察，不代表完整更新授权矩阵。

## 本机清理

两壳与sidecar均已正常退出。Electron精确service的实际account为 `Ruukoto Tailscale Acceptance Electron Key`；准备文档少写了Key后缀，初次按旧account删除返回缺项。随后只读该测试service元数据核准account，删除并验证缺项；未导出秘密。MyGo精确production测试service/account同样删除并验证缺项，见两份Keychain清理JSON。独立应用数据目录已删除，Tailscale accept-dns恢复并读回false，见 `local-cleanup.json`。制品与无秘密证据保留供审阅。

## 服务器清理

[冻结清理包](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-tailscale%2Fevidence%2Fgui-20261025%2Flinux-final-cleanup-results.tar.gz)保存最后只读marker、精确两GUI凭据revoked、mock调用总数5、无未决输入/工作/维护、Serve/Funnel配置、三测试单元停止以及容器和专属目录消失的原始结果与执行源码。[结果摘要](linux-cleanup-result.json)确认生产 `ruukoto-backend.service` 前后保持active、MainPID3041190。只移除原测试443代理，不重置其他tailnet配置，拥有者grant与管理员开启的HTTPS能力保留。

## 独立闭合

[最终独立复核](final-independent-review.json)对照12张实际画面、原始marker链、重开/退出、精确撤销与本机/Linux清理结果，无未解决事实性阻断。代码与负例执行范围分别由前述两处修复报告持有；React/Radix真实UI红绿由审查者核对作者源码和原始日志，不冒称审查者亲跑。

## 未覆盖范围

两壳本轮均未观察到Keychain授权框；这只能证明当前已解锁环境下的创建、保存与重开读取，不能证明拒绝、锁定、损坏或ad-hoc更新授权矩阵通过。Code使用编译时隔离空目录，没有连接日常Code后台，因此不算正式Code/终端产品验收。非拥有者/tagged、策略/设备撤销、整机重启及真实模型/IM仍按工单保留未验。
