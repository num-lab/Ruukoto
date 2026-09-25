Status: needs-triage

# 关闭 pi 的 SYSTEM.md / APPEND_SYSTEM.md 自动发现

## 问题

[session-factory](../../../src/agent/session-factory.ts) 关闭了扩展、技能、提示词模板、主题与上下文文件的自动发现，但没有传入系统提示相关的选项。pi 0.85.1 的 `DefaultResourceLoader` 在这种情况下仍会自动查找（`node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:381-399, 809-829`）：

- `<cwd>/.pi/SYSTEM.md`（项目被视为可信时；`SettingsManager.inMemory` 默认可信）或 `<agentDir>/SYSTEM.md`，用来替换默认系统提示；
- `<cwd>/.pi/APPEND_SYSTEM.md` 或 `<agentDir>/APPEND_SYSTEM.md`，追加到系统提示。

## 影响

- 工作区仓库里的 `.pi/SYSTEM.md` 或 `.pi/APPEND_SYSTEM.md` 会进入该工作区所有会话的系统提示，绕过「项目指令只来自显式配置的工作区文件，不重开自动发现」（[05](05-context-and-memory.md)）。
- 系统提示不经选择器的资料范围门控；`<agentDir>/SYSTEM.md` 会影响包括 QQ 群在内的全部会话。
- 仓库中没有文档或测试覆盖这一点。

## 待定

- 选用哪个 loader 选项封住发现（显式 `systemPrompt` / `appendSystemPrompt`，或对应的 override）。
- 回归测试：在工作区 `.pi/` 与 agentDir 放置这两个文件后，系统提示保持不变。

## Comments

### 2026-09-25：创建

在技能系统访谈（[22](22-skills.md)）中顺带发现。已核对 pi 代码，未写复现测试。
