# 30 独立审查

审查对象是[工单 30](../../issues/30-browser-media.md)、规格 A2/A5/A6/A7/A8/A9/A11、浏览器/媒体与管理接线、共享 Coding 调用方及对应证据。主工作区由实施者写入；浏览器和媒体并行实现分别使用 `/private/tmp/ruukoto-30-browser-32135`、`/private/tmp/ruukoto-30-media-32135`，审查在不同上下文直接读实际源码和测试，不以作者总结代替。

## 方案

`browser_plan_audit`、`media_plan_audit` 分别核对浏览器与媒体细化，`integration_audit` 核对权限、归属、共同暂停及调用方。方案收敛为复用无旧运行权威的 BrowserManager/参数和现有不可变产物，由 durable 保存接纳、开始、观察与归属；保持主拥有者完全访问身份、子会话不开放浏览器；Telegram 先接 photo，QQ 由 31 接同一媒体规则。没有改变既定产品取舍或把实现选择升级为新审批。

## 实现与返工

`integration_audit` 审浏览器及根接线，亲跑个人浏览器 12、共享生命周期 17、共享工具 22 项。构造删除未知操作文档和索引的反例，发现单向归属可抹掉来源暂停；补绑定/配置/接纳/开始/观察/暂停/核实/停止任务的历史反链后，反例拒绝。另构造本机旧接纳输入先受限、后来改默认完全访问的委派反例，发现委派/分析未使用已固定的权限；修正为沿原 LocalInputDoc，并核实 Task/Submission 来源后，反例通过。两项不涉及降低权限要求。

`media_plan_audit` 独立审浏览器与组合，新增组合用例并亲跑 13/13，检查实际 provider 工具可见性、截图/读图与产物、无 general 的 reader、本机模式控制、Telegram 浏览器菜单和未知跨工具暂停。之后只读核对最终模型可见文本与人类文档；页面丢失提示、纯文本模型截图前拒绝、读文件图片结果和 Telegram photo 范围均按实际行为明确。

`browser_plan_audit` 独立审媒体最终实现并亲跑 14/14；用实际三种 SDK 的 fetch 捕获检查图片字节和留存引用，拒绝未知/缺失/变造/外链图片，核对同字节不同来源、压缩引用和历史保留。三个 SDK 探针已复制到本机证据并由实施者复跑，均通过；不是真实视觉模型。

`integration_audit` 亲自在 Linux 核对源码/依赖清单并执行 56/56，尝试真实 Chrome 后按沙箱失败保留缺口，核对归档后清理本次专属目录和进程；材料与最终两处描述差异见[Linux 记录](../30-linux/README.md)。

## 请求快照断言

独立审查读 SDK 与原生 durable 重试路径后，实际注入首次 fetch 到 HTTP 前失败，得到 2 份准备 payload、2 个 requestId、1 次 HTTP 与原生连接错误；可重跑脚本、原始记录、摘要和日志为 `payload-retry-probe*`。最终断言只去掉相邻完全相同的项，保留两边顺序及每条 HTTP 的原始快照匹配。审查者重放 `payload-retry-observed.json` 的 14/13 记录通过，并分别变造请求内容、删除一个独立请求验证断言会失败；亲跑最终主子读写/请求重建用例 1/1。生产记录没有为计数断言删改。

## 结论与边界

独立实现审查无未解决代码阻断，最终合并回归 207/207 和静态检查通过。审查结论只覆盖本次源码、窄用例和保留证据；最终内容由 `implementation-manifest.json` 定位。早期失败及修复在[本机证据](README.md)分别记账。

`media_plan_audit` 最后逐项重算实施清单 45/45 的字节数和 SHA-256，独立核对 Linux 66 项中 64 相同、2 项恰为已披露工具描述差异，归档哈希相符；核对所有最终计数、工具描述、usage、30/31/01 状态与 remaining-work 的历史边界，无交接阻断。本机 `verify-handoff.mts` 另核对 7 份 Markdown 的 49 处相对链接/锚点、单行段落、唯一状态、文件结尾，以及实施清单、Linux 源码差异和 15 项归档内容，见 `handoff-check.json`。

真实视觉模型、真实 Telegram、QQ 接线、Linux 真 Chrome 和操作者体验均不能由离线通过或独立代码审查替代，继续待验收。工单为 ready-for-human，不是 resolved；未提交、推送、切正式入口或部署。
