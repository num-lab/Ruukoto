Status: ready-for-agent
Depends on: 03, 05

# 工具结果视图上限提到 80,000 字符

## 目标

模型能完整看到刚拿到的工具结果（pi read/bash 的 50KB 输出、各分页工具的 64KB 单页）；视图上限只兜底真正超大的结果。

## 背景

2026-09-26 核对：

- 选择器对视图中每个 toolResult 文本段套用 `toolResultViewChars`（默认 4000，`src/agent/context-selector.ts:58`），超出只留首尾各一半（`:459-484`），最新批次也不例外；只有 `skill` 豁免（`:464`）。用 200K 窗口实跑 `selectContext`：刚 read 的 300 行文件（约 12KB）只剩第 1–54 行与第 253–300 行。本机 38 条选择记录中已有 6 次截断。
- 省略提示让模型改用 `read_artifact`，但它默认返回 64KB（`src/agent/tool-router.ts:707`），同样会被截。
- 各工具自身的上限：pi read/bash 为 50KB 或 2000 行（`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js:10-11`），外加一行续读提示；`history_read` 单页 64KB（`src/agent/host-tools.ts:50`）；`coding_result` 回答 16KB、产物 64KB（`src/agent/delegation-tools.ts:32`）；`read_artifact` 默认 64KB、最大 256KB；MCP 内联 32K 字符（`src/agent/mcp/client.ts:38`）；web_search 最多 5 条、每条正文 2000 字符（`src/agent/web-search.ts:29, 35`）。`http_request` 响应最多 1MB、`request_file_access` 读最多 8MB（`src/agent/execution/approved-ops.ts:29-30`），只能靠视图上限兜底。
- 本机模型目录（`~/.ruukoto/agent/models.json`）中的 3 个模型都是 1M 窗口、maxTokens 384K（tx 的目录未核对）；thinkingBudget 恒为 0（`src/agent/model-selection.ts:86`），输入预算约 60.6 万估算 token。
- 上限只能取决于消息本身：按位置区分（当前批次不截、变旧后再截）会让同一条消息的视图变化，之后每次调用都会让其后的提示缓存失效。

## 实施范围

- `DEFAULT_BUDGET_CONFIG.toolResultViewChars` 从 4000 改为 80,000，能容纳 pi 的 50KB 输出与 64KB 单页加头部。加 `ponytail:` 注释：定值不随模型窗口变化，接入 128K 级窗口时，一批多个大结果可能触发 `context_budget_exceeded`，届时改为按预算比例收紧。
- `read_artifact` 单次上限从 256KB 降到 64KB（`src/agent/tool-router.ts:707`），参数说明（`:827`）同步，使单页不会被视图截断。
- `docs/runtime.md`「上下文选择」中有界节选一条写明上限与理由。

## 已确认范围

2026-09-26 访谈确认（Q1 按推荐）：

- 固定上限 80,000 字符；不按位置区分，不去掉上限。
- 不改 `history_read`、`coding_result` 的单页：64KB 加头部已在上限内。
- 代价是每次调用的 token 变多；按本机模型目录的单价，DeepSeek 缓存命中为未命中的 2%（flash）/ 3.3%（pro），主要成本只在首次发送。

## 验收标准

离线测试覆盖：

- 默认配置下，约 12KB 的 read 结果与 64KB 的 `read_artifact` 单页在模型视图中完整，`cappedToolResults` 为空；超过 80,000 字符的文本段仍按首尾节选，并记入 `cappedToolResults`。
- `read_artifact` 请求超过 64KB 时按 64KB 返回。
- `test/52-jev.test.ts:68-75` 依赖默认的 4000 上限（10,000 字符的结果必须被截断），改为显式配置 `toolResultViewChars`。

`npm run typecheck` 与 `npm test` 通过；`docs/runtime.md` 同步更新。

## 关联与后续

- [05](05-context-and-memory.md) 的有界视图约定；[29](29-context-prefix-stability.md) 同属上下文组装优化。
- 另行立项：按模型预算比例的上限（接入小窗口模型时）。

## Comments

### 2026-09-26：创建与访谈确认

prompt 组装优化访谈 Q1 按推荐确认。

访谈中没有单独提问、按已确认的决定推导的细节（请复核）：

- 省略提示里「可用 history_read 按来源读取」对没有产物的结果（`http_request`、`request_file_access`、MCP 内联）不好用，因为视图中没有条目 id。上限提高后很少触发，本工单不改提示文字。
- 64KB 的 `read_artifact` 单页加头部约 65.7K 字符，`history_read` 单页加头部同量级，都在 80,000 以内；这些上限按 UTF-8 字节计，中文内容的字符数更少。
