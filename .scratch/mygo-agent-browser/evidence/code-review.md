# 独立实现审查证据 — mygo-agent-browser

- 对象：`git diff c39b8ddc...HEAD`（8349a495、38e00678、fdebc8b9、c0352e51 四个实现提交）
- 方式：code-review 双轴独立子代理（Standards 轴对仓库成文标准 + Fowler 坏味基线；Spec 轴对工单与已实施决定），只读审查
- 日期：2026-10-29；审查结果修复于 `a722dbb7`

## Spec 轴命中（均已修复）

1. `open` 绕过接管闸门：agent 侧对 open 豁免闸门检查、Go 侧 `open()` 无条件 `setOwned(true)`，接管期迟到 open 会夺页并伪造 `gate owned:true` → 虚假交还观察。**修**：open 只在页面不存在/已消亡时直放，存在且被持时同样等交还；Go 增 `ownerHeld` 标记，接管期 open 直接 `page_owned` 拒绝。
2. 关页后无法重开：`gone` 粘性使重开后命令仍 `disconnected`。**修**：open 成功清除消亡投影。
3. 快照引用只按 `connectionId|session` 键，不符「绑 (任务, 页面代次)」。**修**：快照条目带 taskId 校验，同会话后续任务不复用。
4. 无调用方的 `own`/`release` 命令面与 `TRANSFER_FIELDS.snapshot` 死字段：**删**。
5. 面板导航控件禁用方向反置（Agent 持有时反而可用），地址栏恒可用：**修**为 `!ownerHeld` 禁用，`submit` 加闸门护栏。
6. 锚点指向已迁走的 proposed 笔记：**六处**改 implemented 路径。

## Standards 轴命中（均已修复或记录）

- `fullRes.value.value` 恒 undefined → 超 24k 快照全文产物为空文件：**修**为 `fullRes.value`；全文取回失败回落截断标注而非整动作失败。
- `result_too_large` 误标 `unknown`（只读结果未送达被记效果未知）：**改** `not_sent`。
- 错误码双重拼接 `（code）（code）`：去掉内层拼接。
- preload `send()` 把失败转 resolved `{ok:false}`，面板 `.catch` 永不触发 → Go 侧拒绝全部静默：**修** `run()` 按应答形状上报，并删 `/page_owned|not_owned/` 的 message 解析。
- `safeJson` `any` 泄出 JSON 边界：收窄 `unknown`。
- `forgetSession` 注释称丢投影但 `states` 不删：**修**为真删。
- 工具参数零描述（action↔参数配对模型无从得知）：补每参描述。

## 判断题保留项（不修复）

- `awaitGate` 用 25ms `stopped()` 轮询解等待：次序上「先唤醒再 abort」由 Driver 取消路径与发送边界复查兜底，轮询是刻意简化（无通用暂停状态机），记录在案。
- `desktop_browser_open/release` 旧文档预览 op 与新通路同名不同义：改名牵涉持久 op 名与回归面，保留并记录。
- `DesktopBrowserEvent` 三处异构类型声明（protocol 严格型/管理器松散型/runtime 内联）：分属 wire/内部/装配三层，保留。
- 测试两处 `setTimeout` 等待：仓库未禁时序等待，用例语义为「确认未发送」，保留。

## 结论

两轴各命中若干真实缺陷，无方案级阻断；全部硬违规与 Spec 偏差已修复并附回归（`desktop-browser-manager.test.ts` 增 open 闸门/重开用例，8/8 过）。A1 真实模型闭环、A2/A3/A5 整链路、A9 实窗、A10 拥有者体验仍属未执行项，不在本审查范围。
