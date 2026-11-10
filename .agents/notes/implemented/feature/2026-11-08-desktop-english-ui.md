# Agent Note: Desktop interface text is English

Status: implemented

## Problem

Desktop mixed languages on one screen: sidebar actions, model menus and tool traces were English while workspaces, settings navigation, schedules, empty states and errors were Chinese. The same concept had different names in different places (`Select Model` and `选择模型`, `Off` and `off`), and the page declared `lang="zh-CN"`.

## Decision

Text that Desktop itself authors for the owner is English: renderer labels, placeholders, accessible names, empty, loading and error states, toasts, settings, schedules, inspector pages and tool-trace labels; Electron and MyGo host messages returned to the renderer, native dialog titles and notifications; and `[ruukoto:desktop]` diagnostics. The document language is `en`, and dates, times and relative times are formatted with the `en-US` locale.

The scope is Desktop-owned text in `apps/desktop/`. Strings produced by backend packages and shown verbatim (control and runtime errors, status details, conversation titles) keep their source language, because the TUI and IM entries share them. Text that can enter a model request is unchanged: command results returned to the control backend by `src/main/browser-bridge.ts`, the MyGo `browser_command` dispatch in `mygo/main.go`, the `mygo/browser/browser.go` command path, and the `mygo/transport.go` failures shared by owner and backend commands. `test/desktop-han-scan.test.ts` rejects Han text in Desktop source string literals outside comments, with an allowlist for exactly these strings and the frozen files. The frozen demo and its fixtures keep their original text, so shared primitives whose text was translated (`components/ui/dialog.tsx`, `connection-loading.tsx`, `sidebar-resizer.tsx`) are no longer compared byte for byte with the frozen demo. The executable regression helpers in `test/fixtures/desktop/` load production components and follow current interface text; they are not frozen demo baselines.

Copy uses sentence case. Labels and buttons have no final period; complete sentences do. Progress uses an ellipsis (`Saving…`). Recovery guidance is one short imperative sentence after the fact (`Couldn't save. Try again.`). Counts are pluralized (`1 file`, `3 files`). Product terms follow [CONTEXT.md](../../../../CONTEXT.md), with these interface names:

| Chinese | English |
| --- | --- |
| 会话, 新会话 | chat, New chat |
| 工作区, 无工作区 | Workspace, No workspace |
| 存档, 已存档会话 | Archive, Archived chats |
| 计划任务, 运行 | Schedule, Run |
| 审批, 批准, 拒绝 | Approval, Approve, Deny |
| 确认模式, 完全访问, 自动审核, 计划模式 | Ask for approval, Full access, Auto review, Plan |
| 子 Agent | SubAgent |
| 电脑 | Computer |
| 模型, 推理档位 | Models, Reasoning effort |
| 上下文使用量 | Context usage |
| 结果未知, 副作用不明 | Outcome unknown |
| 外观, 跟随系统, 浅色, 深色 | Appearance, System, Light, Dark |
| 设置 | Settings |
| 草稿仍保留 | Your draft is kept. |
| 不会自动重发 | It won't be resent automatically. |
| 请重新打开应用 | Reopen the app. |

## Alternatives considered

Converting backend messages as well would remove the remaining Chinese errors in Desktop, but those strings are shared with the TUI and IM replies, and the owner limited this change to Desktop. An i18n layer with message catalogs would allow both languages, but nothing requires runtime language switching, and catalogs add indirection to every label. Keeping Chinese and translating only the English strings would also unify the interface, but the owner chose English.

## Consequences

The Desktop interface reads in one language except for verbatim backend text. Renderer and host tests assert the English strings; test titles keep their original language. New Desktop copy follows the table above; a term missing from it is added here rather than invented per screen.
