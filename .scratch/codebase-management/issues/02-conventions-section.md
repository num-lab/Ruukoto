Status: ready-for-agent

# 02 — 根 AGENTS.md 增设「约定」章节

**What to build:** 把本仓库已经稳定遵守、但只存在于代码习惯里的规则写进根 `AGENTS.md`，让 agent 在改动前就拿到判断准则，而不是靠读代码反推。

**Blocked by:** 01（要先有「按改动面选检查」的阶梯，新章节才不必为每条规则附全量验证要求）

## 验收标准

- [ ] 新增「约定」小节，每条 1-2 行，说明该做什么并链接承载细节的文档（`docs/modules/*.md`、`docs/architecture.md`、`docs/development.md`、`CONTEXT.md`、notes）。
- [ ] 只收录取证成立的规则：零反例，或反例边界明确且可写清。
- [ ] 取证结论里「NOT actually followed」的 9 条零出现。
- [ ] `AGENTS.md` 仍保持指示层定位：不写演进史、不复制被链接文档的内容。
- [ ] 决策 note 与工单同批落盘。

## 候选规则（取证见下）

模块边界：

- `src/core/` 不得 import 其他 `src/` 区（26 个文件出边为 0，零反例）。
- 跨区反向引用只允许 `import type` 或注入回调，不得直接调用运行时实现。

错误处理：

- 跨层错误转成带 `code` 的类型；调用方用 `instanceof` + `.code ===` 判别，不解析 `message`。
- 不写空 `catch`；确需吞掉时写明吞的是哪个错误与原因。

类型：

- 类型逃逸（`any`／`as unknown`）只允许出现在三类边界：SQLite 行映射、JSON/wire 解析、第三方 SDK；内部同进程接口用真实类型，不重复校验。

持久化：

- 状态与其事件在同一事务内写入，提交后才广播。
- 会话 JSONL 是消息历史的唯一权威副本；`src/core/` 只读不写；不得声称 SQLite 与 JSONL 之间原子。
- `SCHEMA_VERSION` 单调递增，过新的库直接拒绝启动。

语言与形态：

- ESM-only；相对 import 一律带 `.ts` 扩展名。
- 文件名 kebab-case；库代码不写 `console.log`，诊断走 `process.stderr.write` 带 `[ruukoto:*]` 前缀。
- 注释与文档用中文，标识符用英文；术语按 `CONTEXT.md`。
- 代码里承载决定的入口留 `Note: 见 .agents/notes/<路径>` 锚点，格式唯一。

## 依据

### 模块边界

- `core` 出边 0：`src/core/store.ts:10`、`src/core/db.ts:12`、`src/core/access.ts:1`。
- 反向 type-only：`src/qq/adapter.ts:28-29`、`src/telegram/adapter.ts:22-23`；装配线 `src/runtime/runtime.ts:126-143`。

### 错误处理

- 带 code 的子类：`src/core/api-error.ts:2-7`、`src/core/access.ts:25-30`、`src/core/history.ts:32-38`、`src/agent/web-search.ts:52-62`。
- 判别方式：`src/runtime/runtime.ts:997,1015,1028,2092`、`src/tui/app.ts:2800`。
- `.message.includes(` 仅 3 处，全是 SQLite 唯一索引兜底：`src/core/store.ts:2185,2990,2995`。

### 类型

- `rowToXxx(row: any)` 行映射 29 个签名：`src/core/store.ts:300,569,925,1129,2525,2922`。
- wire 边界 `as unknown`：`src/agent/app-data/store.ts:782,856,878,1126`。
- 外边界校验助手：`src/core/types.ts:48,53`、`src/qq/onebot.ts:329`。

### 持久化

- 同事务与提交后广播：`src/core/store.ts:8,90-107`、`src/core/db.ts:6-8`、`src/runtime/runtime.ts:488`。
- JSONL 唯一权威副本：`src/core/db.ts:5,8`、`src/core/history.ts:4`。
- 版本：`src/core/db.ts:15,683-684,713-715,741`。

### 语言与形态

- 550/550 相对 import 带 `.ts`，0 个 `.js`。
- 文件名 kebab-case 全量无例外；`.ts` 全部以换行结尾。
- `console.log` 9 处全在入口层：`src/cli.ts:92,447`、`src/tui/index.ts:107-121`、`src/config-tui/index.ts:261-269`。
- 锚点格式：`src/` 67 处 + `test/` 18 处，前缀 100% 为 `.agents/notes/implemented`。

### 不得写入（取证结论的 NOT actually followed）

1. 「execution 是唯一产生进程的地方」——`node:child_process` 出现在 9 个文件，含 `src/core/instance-lock.ts:21`、`src/dev.ts:331`、`src/control/ensure-backend.ts:161`。
2. 「tui 只通过控制协议访问后端」——3 条 type-only 直连 `agent`，20 条直连 `core`。
3. 「适配层只被 runtime 调用、绝不反向」——`src/scheduler/news.ts:3`、`src/github/events.ts:8,9,11,12` 反向。
4. 「测试只断言行为、不断言数据布局」——42 个测试文件直读 SQLite，263 处裸 SQL，是刻意做法。
5. 「错误 code 一律字面量联合类型」——42 个子类里 16 个无 code。
6. 「不允许 `any`」——406 处，且 lint 显式关闭该规则。
7. 「导出必须有 JSDoc」——179/298，60%，无门禁。
8. 「测试编号唯一」——10 组重号。
9. 「分层严格单向」——真实机制是注入回调 + `import type`。

## Comments

### 2026-10-10：初步判断被推翻

盘点前的初步判断「`execution` 是唯一把执行移出进程的边界」不成立，已列入不得写入清单。规则只按取证结论写。
