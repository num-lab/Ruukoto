# Agent Note: 两个产品在同一仓库内改为 workspaces 分包

Status: proposed

## 问题

本仓库以一个代码包交付两个产品（`ruukoto` 个人 Agent、`ruukoto-code` Coding Agent），[产品入口决定](../../implemented/architecture/2026-10-02-two-agent-products.md)当时把「每个产品拆成独立 package」列为备选并否掉，条件是「只有确需独立打包和发货时才重访」。现在要重访，但驱动因素不是发货隔离，而是两件事同时成立：产品差异缺少一个显式的、可检查的落点；模块边界已经写在 [AGENTS.md](../../../../AGENTS.md) 里却没有工具执行，正在漂移。

耦合的实测分布如下。`src/` 共 52,117 行、112 个文件，其中共享底座 39,668 行（76.1%，89 文件）、个人 Agent 专属 8,953 行（17.2%，19 文件）、Coding Agent 专属 3,496 行（6.7%，4 文件）。按产品判等的分支只有 27 处，落在 12 个文件里，且全部是开关与参数而非整段功能替换；`src/core/` 与 `src/agent/` 对产品零知识，差异集中在 [runtime.ts](../../../../src/runtime/runtime.ts) 的装配路径上。

边界漂移的证据更关键。AGENTS.md 规定 `src/core/` 不得 import 其他区、跨区反向引用只允许 `import type`，但 [eslint.config.mjs](../../../../eslint.config.mjs) 里没有任何 import 边界规则，仓库没有架构边界测试，也没有 CODEOWNERS。`core/` 本身守得住（0 处越界），但全仓反向边有 29 条，其中 [subagent-tools.ts](../../../../src/agent/subagent-tools.ts) 从 `runtime/` 引入 `messageStateText` 与 `subagentOpCheck`，是真实的运行时值引用，已经违反规则。规则靠文档约束不住，这是本方案要解决的一半问题。

失败条件：如果分包后越界 import 仍然装得上、只在评审时靠人看，本方案就没有解决它声称要解决的问题。

## 方案

启用 npm workspaces，把源码按包切分，让依赖图本身成为架构图。拟议布局：

| 包 | 来源 | 规模 |
| --- | --- | --- |
| `packages/core` | `src/core/` | 7,377 行 / 15 文件 |
| `packages/agent` | `src/agent/` | 15,045 行 / 42 文件 |
| `packages/runtime` | `src/runtime/` 减去个人专属文件 | 约 9,300 行 |
| `packages/control` | `src/control/` | 2,455 行 / 11 文件 |
| `packages/channels` | `src/qq/`、`src/telegram/`、`src/github/`、`src/scheduler/`，加移入的 `im-approvals.ts`、`im-entries.ts`、`inbound-media.ts`、`personal-import.ts`、`github-retirement.ts` | 约 8,900 行 |
| `packages/tui` | `src/tui/`、`src/config-tui/` | 8,325 行 / 17 文件 |
| `apps/ruukoto` | `bin/ruukoto.mjs` + 个人 Agent 专属装配（`service-tools.ts`、`chat-result-tools.ts`、`scheduler-tools.ts`） | — |
| `apps/ruukoto-code` | `bin/ruukoto-code.mjs` + Coding 专属（`dev.ts`、`code.ts`、`legacy-import.ts`、`workspace-migration.ts`） | — |

`packages/tui` 归共享而不是 Coding 专属，因为 `ruukoto` 保留普通开发会话与 TUI 入口（[产品入口决定](../../implemented/architecture/2026-10-02-two-agent-products.md)第 37 行），两产品的 TUI 差异只是列表展示形态，不是能力有无。

**迁移分五步，每步独立可交付。** 第一步只启用 workspaces 并抽出 `packages/core`，验证 tsconfig、tsx、esbuild、测试路径四条链路打通；[verification/foundation](../../../../verification/foundation/package.json) 已经是同仓第二包的先例，有独立锁文件与独立 typecheck，说明这条路可行。第二步抽 `agent` 与 `control`，同时用 `no-restricted-imports` 把分层规则写成按包的越界即红，这一步本身就消灭了 29 条反向边的问题。第三步抽 `runtime`，并把个人专属文件移入 `channels`。第四步建两个 app 包，各自持有 bin 与产品专属装配。第五步收尾门禁：每包独立 typecheck，根 `check` 改为聚合。

**worker 构建必须保持单点。** `src/agent/tool-worker/worker.ts` 打包成 `worker/worker.mjs` 是两个产品共用的执行边界，worker 内零产品知识，而 `ruukoto-code` 的默认执行后端就是 `container`，硬依赖 `deploy/worker-image/` 这枚镜像。分包后构建命令与 [Dockerfile](../../../../deploy/worker-image/Dockerfile) 的 `COPY` 路径要跟着改，但产物仍然只有一份，禁止两个 app 各自构建——各自构建等于分叉安全边界。

**schema 与控制面协议仍由单包持有。** 37 张表与 `SCHEMA_VERSION = 32` 留在 `core`，87 个控制面 op 留在 `control`，两个 app 依赖同一份。分包不解除版本统一，这是有意保留的约束而非遗漏。

## 技术前提与未知

现有的 import 形态是 [tsconfig.json](../../../../tsconfig.json) 的 `moduleResolution: "bundler"` 加 `allowImportingTsExtensions: true`，全仓 550 处相对 import 带 `.ts` 扩展名。跨包 import 能否继续用 `.ts` 后缀，取决于 `exports` 映射与 tsc 的交互：tsx 在运行时按 `exports` 解析 `.ts` 源码没问题，但 `tsc --noEmit` 走 bundler resolution 时能否跨包解析 `.ts` 目标需要实测。**这是本方案最大的未知，也是第一步只抽 `core` 的原因**——一个包就能证伪或证实它。

若跨包 `.ts` 解析不可行，退路有两条：改用根 tsconfig 的 `paths` 映射承担类型解析、`exports` 只服务运行时；或放弃 `allowImportingTsExtensions`、跨包引用改回 `.js` 后缀。两条都不影响包边界本身。

另有两个待定项。测试夹具 [testkit.ts](../../../../test/helpers/testkit.ts) 被 85 个测试引用，分包后它属于哪个包、如何被跨包测试共用，需要与第一步同时定下来。npm workspaces 会改变依赖提升行为与锁文件结构，根 `package-lock.json` 与 `verification/foundation/package-lock.json` 的既有关系要理清。

## 备选方案

- **拆成两个仓库** — 最强的论据是它给出真正的发货隔离：两个产品各自有仓库、CI、发布节奏与访问控制，不需要第三个共享层的版本协调就能独立演进，也不会有人误以为改一侧不影响另一侧。不选，是因为成本结构与收益不匹配：76.1% 的代码是共享底座，worker 构建、DB schema、控制面协议、10 个 `scripts/` 门禁脚本与 6 个笔记校验脚本都是「两边必须一致」的硬契约，拆开后必须另造一个第三方共享包并长期承担跨仓版本对齐；测试层 108 个文件中 80 个（69.7%）是共享契约测试，也要两边同跑。仓库自身历史也支持这个判断：242 个提交中只有 4 个同时触及两侧专属目录。发货隔离目前不是真实需求，等它成为需求时，本方案是它的前置投资而非对立面——分好包之后再把 `packages/*` 各自独立成仓，比现在直接切要便宜得多。
- **只加 import 边界规则，不动物理结构** — 最强的论据是成本最低（约一天）且直接命中「规则没有被执行」这个真问题，`no-restricted-imports` 加负例测试就能让 29 条反向边当场现形，是任何后续拆分的前置条件。不选作为本方案的替代，是因为它只解决边界漂移、不解决产品差异缺少落点：27 处产品分支仍然散在 12 个文件里靠 `if` 表达，越界规则也只能靠正则匹配路径、无法表达「哪个包可以依赖哪个包」的完整依赖图。它的内容已并入本方案第二步，不是被放弃。
- **把产品差异收敛成一张能力表** — 最强的论据是直击产品耦合本身：让产品声明能力集（渠道、调度器、服务管理、默认执行后端、UI 形态），`runtime.ts` 读表装配，27 处分支收敛成约 15 行数据，加第三个产品不用碰 `runtime.ts`。不选作为本方案的替代，是因为它是正交的另一半：能力表让产品差异可读，分包让模块依赖可检查，两者互不替代。它不解决 `agent/` 违规引用 `runtime/` 这类与产品无关的边界问题，而后者才是当前正在漂移的部分。可以在本方案落地后独立推进。
- **保持现状不动** — 最强的论据是当前形态已经满足两产品独立运行、独立重启、独立档案与实例锁的全部需求，[test/71](../../../../test/71-product-entry.test.ts) 有真实双后台回归覆盖，且没有交付压力。不选，是因为边界漂移已经在发生（`subagent-tools.ts` 的运行时反向引用），放任下去会让后续任何结构性改动都更贵；而且「独立运行」和「依赖清晰」是两个不同的目标，现状只满足前者。

## 验收标准

- 每个 app 包能独立产出自己的制品（bin 与所需镜像），且 `worker/worker.mjs` 仍由单点构建、两产品共用同一份产物。
- 越界 import 无法通过：跨包违规引用被 eslint 或包解析拒绝，并有负例测试证明它会红。29 条现有反向边逐条定性，合法的注入回调保留，违规的改掉。
- 产品差异有显式落点：27 处按产品判等的分支缩减为包内的能力声明，`runtime.ts` 不再直接按 `ProductType` 分支装配。
- 现有门禁全绿：`npm run check` 通过，`test/71` 的双后台并存、独立停止、跨产品目录拒绝三项回归通过，`verification/foundation` 独立 typecheck 不受影响。
- 迁移期间行为不变：每一步交付后两产品的可观察行为与迁移前一致，`SCHEMA_VERSION` 与控制面协议版本不因分包而变化。

## 风险

- **跨包 `.ts` 解析可能不成立。** `allowImportingTsExtensions` 与 `moduleResolution: "bundler"` 跨包是否可用未经验证，是本方案最大的技术未知。第一步只抽 `core` 就是为了尽早证伪；两条退路（`paths` 承担类型解析，或跨包改 `.js` 后缀）都会带来额外的 import 书写不一致，但没有一条会推翻包边界。
- **包边界会暴露被掩盖的循环依赖。** 现在是单区自由 import，29 条反向边里 `agent/` 对 `runtime/` 的运行时引用、`control/server.ts` 对 `runtime/` 的引用都会在分包时变成硬性阻碍，必须通过注入回调或下沉共享类型来解开。这一步的工作量可能超过抽包本身。
- **测试夹具的归属会成为长期的跨包约束。** `testkit.ts` 被 85 个测试引用，若放进某个包，其余包的测试都要依赖它，等于在包图里引入一条测试专用的横向依赖；若不放进任何包，就要为测试单独建包。两种都不理想，且会持续影响后续的包划分。
- **workspaces 改变依赖解析与锁文件行为。** 依赖提升规则变化可能让原本靠根 `node_modules` 偶然可用的依赖变成显式的包依赖，需要在每包 `package.json` 里补齐；根锁文件与 `verification/foundation` 独立锁文件的关系也要重新理清，否则 `npm run setup` 与 CI 的缓存策略会失效。
- **收益是渐进的，代价先付。** 前两步不产生任何可观察行为变化，只有结构变化与门禁加强，容易在收益显现前被叫停；而半完成的包切分（例如 `core` 已抽出但 `runtime` 仍混着个人专属文件）比现状更难理解。缓解办法是每步都保持可交付、可回退。
- **最终仍可能要拆成两仓。** 本方案不排除那个终点，只把它推后并降低其成本。风险在于如果团队把分包当作终局、不再评估发货隔离的实际需求，可能在中途停止投入而停在半完成状态。
