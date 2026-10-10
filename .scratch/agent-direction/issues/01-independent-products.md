Status: resolved

# 01 — 两个产品独立安装和启动

**What to build:** 以两个产品入口启动独立实例，配置、数据、凭据和停止操作互不影响；在迁移期兼容现有角色与旧数据。

**Blocked by:** 无，可立即开始

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

## 验收标准

- [x] 两个产品可以分别构建、安装和升级；升级或停止一端不要求另一端同时升级或停止。
- [x] Coding Agent 不启动消息平台连接或个人调度；Personal Agent 可独立进入原有拥有者主会话。
- [x] 同机并存时配置、数据锁和控制面不会串用；新产品不会误用开发本项目的隔离实例。
- [x] 采用兼容扩展接入产品类型，保留旧记录的可读性，不在本单全局重命名角色或存储字段。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-02：实施完成

**实现方式**

- 产品身份：`src/core/product.ts`（新增）——`RUUKOTO_PRODUCT` 注入（未设置默认 `ruukoto`，非法取值拒绝启动），`bin/ruukoto-code.mjs` 固定赋值 `ruukoto-code`（`package.json` 增加 bin 条目）。
- 兼容扩展：数据目录归属登记在核心库 meta 键 `product.type`（首次启动补记；schema 仍为 v18、无迁移、无重命名）；跨产品打开同一数据目录 `Runtime.start` 直接拒绝（`product_mismatch`）。角色与旧记录不动，调度计划等旧记录在本产品库内照常可读。
- Gating：ruukoto-code 在 `Runtime.start` 强制停用 QQ/Telegram 适配器（状态视图按产品标注原因）、不创建调度器（`schedule_cancel` 等操作明确拒绝「未启动个人调度」，main 的 scheduler 工具不装配）；ruukoto 行为不变。
- 目录隔离：档案根 `~/.ruukoto`（个人）与 `~/.ruukoto-code`（编码）；路径环境变量按产品读取（`RUUKOTO_*_DIR` / `RUUKOTO_CODE_*_DIR`，互不承认对方那组）；锁、socket、pending 目录随目录自然分开。选择 `~/.ruukoto-code` 是因为 `~/.ruukoto-dev/` 已被开发实例占用（隔离要求第三项）。`RUUKOTO_OWNER_TOKEN` / `RUUKOTO_OWNER_TOKEN_FILE` 为两产品共用的控制面身份变量，已在文档注明。
- 开发实例：`src/dev.ts` 清洗 `RUUKOTO_PRODUCT` 与 `RUUKOTO_CODE_*` 前缀，开发实例固定为默认产品 ruukoto，新产品与开发实例互不误用。
- `backend.started` 事件增加 `product` 字段（新增字段的可加性扩展，demo 会话同步）。

**验证（模拟与真实环境分列）**

- 类型检查：`npx tsc --noEmit` 通过。
- 新增 `test/71-product-entry.test.ts`（14/14 通过）：产品身份与按产品的目录解析、环境变量隔离、开发实例环境清洗、Runtime gating（适配器停用标注、调度器缺失、归属登记与跨产品拒绝、旧计划记录可读）、bin 进程冒烟、进程级同机并存（真实 bin 后台×2 + 独立停止 + 跨产品开目录拒绝；mock 模型打桩）。
- 回归：29/32/37/40/26/66 共 96 项通过；`test/67-visual-docs.test.ts` 通过（本次顺带修复了 main 上 WIP 合入遗留的三项失败：补齐 `docs/visual/tool-call-path.html` 与 `storage-layout.html` 两页、更新两处失效锚点）。
- 全套 `npm test`：除 2 项 main 上已存在的失败（`13-tui-state` 的 accessModeLabel、`19-tui-demo` 的 session.usage_updated 覆盖——在干净 HEAD 复现，与本次无关）与 1 项并发时序抖动（22-auto-review 单独运行通过）外全部通过；本次改动无新增失败。
- 真实环境（macOS 本机，真实 bin 进程/文件/socket/SQLite，模型打桩）：手动冒烟 10 项通过——两产品同时启动握手、ruukoto-code 状态标注（QQ/Telegram 不连接消息平台）、调度记录可读但取消被拒、停 ruukoto-code 后 ruukoto 照常应答、两端各自优雅停止 exit=0、以 ruukoto-code 打开 ruukoto 数据目录被拒（exit=1，product_mismatch）。同名检查已固化为 test/71 进程级用例可复现。
- 文档同步：`docs/runtime.md`（两个产品入口、数据布局按产品分根、开发实例澄清、部署、验证状态诚实清单）、`README.md`、`docs/visual/`（storage-layout 新页含归属与根目录、deployment 启动顺序与开发实例对照表、task-lifecycle/outbox/control-protocol 的产品条件标注）。

**取舍说明**

- 「分别构建、安装和升级」按单一代码包、两条 bin 入口实现：同一检出提供两条命令，替换检出后各产品按自己的节奏 `stop`/`server` 重启即可，已验证停止互不牵连；若将来要求两个独立制品（各自打包/发货），再拆 package（YAGNI，暂未实现）。
- TUI 首次启动自动拉起本机后台属规格后续行为，本单未实现（`ruukoto-code server` 显式启动，行为同现有 ruukoto）。

**main 上既有的待办失败（本次未动）**：`test/13-tui-state.test.ts` accessModeLabel 显示名、`test/19-tui-demo.test.ts` 合成会话缺 `session.usage_updated` 事件覆盖，均为 d139561 WIP 合入遗留，与本单无关，建议另行处理。

### 2026-10-02：第二轮评审

[评审记录](../review-develop-2026-10-02.md) 补充本工单待修复的 P2 问题 R6：个人产品 bin 未固定身份，继承 `RUUKOTO_PRODUCT=ruukoto-code` 时运行 `ruukoto stop` 会停止开发后台。已用临时双后台真实复现；修复建议及验收条件见记录。

### 2026-10-02：第二轮评审修复（R6）

- R6：bin/ruukoto.mjs 与 bin/ruukoto-code.mjs 同款——入口固定注入 `process.env.RUUKOTO_PRODUCT = "ruukoto"`，不采信外部环境变量；npm start 经环境变量选择产品的能力不变（cli.ts 未动）。
- 回归测试：test/71「bin 入口固定产品身份——继承相反 RUUKOTO_PRODUCT 时启动/查询/停止只作用于本产品」——两条真实 bin 后台并存，shell 继承相反产品变量时各自 bin 的 status/stop 只作用于本产品（个人停止后开发后台仍可握手，反之亦然）。
