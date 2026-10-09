Status: needs-triage

# TUI 的 SubAgent 视图：事件携带变化后的行

## 目标

工作委托与 SubAgent 的事件附带变化后的完整行，TUI 按 id 覆盖；状态规则只留在后台。来源：2026-10-05 架构审查的候选 09（Speculative）。

## 背景

2026-10-05 核对（develop d109dbe）：

- `tui/state.ts` 386–470 从事件载荷重建 `WorkDelegation` / `SubAgent` 行：`originTaskId`、`requestKey`、`paramsDigest`、`workDir` 填空串，并重述后台规则（「委派成功后台恒置 running + 当前任务」）；idle/unverified 之分只能等重连快照。
- agent-direction issue 11/12/14/16/17 每张都改了 `state.ts`。

## 为什么是 Speculative

事件是持久化的，改载荷要升控制协议版本，历史事件仍需旧读取分支；agent-direction 剩下的工作（23、24）里 SubAgent 视图可能不再变化。

## Comments
