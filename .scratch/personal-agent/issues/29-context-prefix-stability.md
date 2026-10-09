Status: resolved
Depends on: 05, 22, 26

# 上下文前缀稳定：让提示缓存覆盖整段历史

## 目标

同一会话的连续调用之间，模型上下文的前缀尽量不变，让 provider 的前缀缓存覆盖系统提示、参考块与整段历史。

## 背景

2026-09-26 核对：

- 模型视图 = 前缀消息（项目指令 → 技能目录 → 继续来源 → 计划说明 → 长期记忆）+ 历史整轮 + 当前任务（`src/agent/context-selector.ts:505-583, 695`）。前缀内容一变，其后整段历史的缓存都失效（[25](25-todo-list.md) 因此不做每次调用注入清单）。
- 项目指令块头带版本 `sha256:…;artifact:<id>`（`:509`），而每个任务都会新建一个指令产物（`src/agent/driver.ts:793`）：配置了项目指令后，每个新任务的第一条前缀消息都会变。技能目录块头带技能库版本（`:523`），它是全部 SKILL.md 正文的哈希（`src/agent/skills.ts:87`），改任一正文就变，即使目录文本没变。两个版本都已写入选择记录（`instruction_version`、`skillVersion`）。
- 记忆在每次调用时重读（`src/agent/driver.ts:589-611`），按「本项目优先 → updated_at 倒序」排序（`src/core/memory.ts:95`）。任务中途 `memory_save` 一次，新记忆就插到最前，本任务其余调用全部 miss。
- 继续来源与计划说明只属于当前任务，却排在全部历史之前，所以 continue 任务的整段历史都会 miss。计划模式的任务本身收窄工具，缓存照样 miss。
- 本机模型目录（`~/.ruukoto/agent/models.json`，tx 的目录未核对）中的 3 个模型都是 1M 窗口，输入预算约 60.6 万估算 token，历史基本不会被移出，每次调用都带整段历史。缓存命中单价为未命中的 2%（deepseek-flash：0.003 对 0.15 美元/百万 token）或 3.3%（deepseek-v4-pro）。pi-ai 把 `prompt_cache_hit_tokens` / `cached_tokens` 记为 cacheRead，选择记录自 2026-09-25 起保存 cacheRead / cacheWrite（`src/agent/driver.ts:1029`）。
- 基线：本机 38 条选择记录都早于 cacheRead 开始落库；tx 的库只有 `ruukoto-backend` 可读，没有取得基线。

## 实施范围

### 1. 块头去掉版本号

- 项目指令与技能目录的块头不再含版本；选择记录中的 `instructionVersion`、`skillVersion` 不变。

### 2. 记忆按任务钉版

- 任务开始时（`loadPinnedContext`，`src/agent/driver.ts:729`）钉住当时生效记忆的 id 与顺序；资料受限会话为空。
- 每次调用只对钉住的 id 重读当前内容，按钉住的顺序排列：已撤销或来源失效的照旧剔除（撤销自后续注入起生效，规则不变）；拥有者中途修订的按新版本注入；任务中新建的记忆从下一任务起注入。排序规则与记忆预算不变；发送前的记忆版本与来源核对（`:882-888`）不变。

### 3. 任务级块挪到当前任务输入之前

- 继续来源与计划说明从视图最前挪到当前任务的第一条消息（任务输入）之前；项目指令、技能目录、长期记忆仍在最前。顺序为：项目指令 / 技能目录 / 记忆 → 历史 → 继续来源 / 计划说明 → 当前任务。
- `/context` 分类与估算口径不变。`docs/runtime.md`「上下文选择」与「计划模式」两节中关于「前缀消息」的描述同步更新。

## 已确认范围

2026-09-26 访谈确认（Q4–Q8 按推荐）：

- 两个块头都去掉版本（Q4）。
- 记忆按任务钉版，排序规则不变。改为按 id 排序没有收益：记忆块在历史之前，集合一变，后面整段历史照样失效（Q5）。
- 继续来源与计划说明一起挪。计划说明不再是「前缀」，这改变了 [26](26-plan-mode.md) 定下的注入位置，注入方式与内容不变（Q6）。
- 估算校准与历史移出迟滞不立项（Q7，见 Comments）。
- 不设前置基线，改完后用选择记录验证（Q8）。

## 验收标准

离线集成测试（mock 模型）覆盖：

- 项目指令、技能目录块头不含版本；选择记录照旧保存两个版本（更新 `test/16-context-memory.test.ts:814`、`test/56-skills.test.ts:132`）。
- 同一任务内先调用 `memory_save` 再继续调用：新记忆不进入本任务后续的视图，下一任务才注入；本任务中途撤销的记忆在下一次调用即被剔除；拥有者中途修订的记忆在下一次调用按新版本注入。
- continue 任务与计划模式任务的视图顺序为：参考块 → 历史 → 继续来源 / 计划说明 → 当前任务输入；普通任务的视图没有这两块。
- 同一会话的连续调用（跨任务亦可），在中间没有记忆变化、也没有继续来源与计划说明时，前一次调用的消息序列是后一次的前缀。

部署后验证（拥有者执行，或授权以 `ruukoto-backend` 身份只读查询）：运行几天后执行下面的查询，`first_call = 1` 的命中率应接近后续调用。

```sql
SELECT call_index = 1 AS first_call,
       count(*) AS calls,
       round(1.0 * sum(coalesce(json_extract(usage, '$.cacheRead'), 0))
         / nullif(sum(json_extract(usage, '$.input')
                      + coalesce(json_extract(usage, '$.cacheRead'), 0)
                      + coalesce(json_extract(usage, '$.cacheWrite'), 0)), 0), 3) AS hit_ratio
FROM selection_records
WHERE usage IS NOT NULL AND created_at >= '<部署时间>'
GROUP BY 1;
```

tx 上：`sudo -u ruukoto-backend sqlite3 'file:/var/lib/ruukoto/data/ruukoto.db?mode=ro' "<查询>"`。

`npm run typecheck` 与 `npm test` 通过；`docs/runtime.md` 同步更新。

## 关联与后续

- [05](05-context-and-memory.md) 的前缀与记忆注入；[24](24-system-prompt-discovery.md) 同改块头（重复说明），后落地的一方合并；[26](26-plan-mode.md) 的计划说明；[25](25-todo-list.md) 的缓存考虑；[27](27-tool-result-view-cap.md) 同属上下文组装优化。
- 另行立项（Q7 的触发条件满足时）：估算按 provider 用量校准；历史移出迟滞。

## Comments

### 2026-09-26：创建与访谈确认

prompt 组装优化访谈 Q4–Q8 按推荐确认。

访谈中没有单独提问、按已确认的决定推导的细节（请复核）：

- 任务级块挪到当前任务之前后，下一个任务开始时这两块不再出现，continue 任务自身的内容会在下一任务的首次调用 miss 一次；仍好于现在整段历史 miss 两次（continue 任务与其下一任务各一次）。
- 计划模式的任务收窄工具，缓存照样整段 miss，挪位置对它没有缓存收益，只是与继续来源保持同一路径。
- 「前一次视图是后一次的前缀」依赖 [27](27-tool-result-view-cap.md) 的固定上限（视图只取决于消息本身）与 Jev 实验关闭；Jev 开启时由筛选结果决定，不在此验收范围内。

未立项（Q7）：估算把每个 CJK 字符按 1 token 再乘校准系数 1.5，DeepSeek 文档的口径约为 0.6 token/汉字，中文内容只用到约四成预算；历史超预算时每次只移出最老的一轮，每移一次，整段历史 miss 一次。1M 窗口下两者都不会触发（约 40 万汉字才开始移出）。接入小窗口模型或出现 `context_budget_exceeded` 后再议：前者可用选择记录的 `estimated_total` 对比 `input + cacheRead + cacheWrite` 调整校准系数；后者可改为单调的移出边界，一旦需要移出就一次移到约 75% 预算。

### 2026-09-26：实现交付

按工单实现：

- 块头：`[项目指令]`、`[技能目录]` 不再带版本；选择记录的 `instructionVersion`、`skillVersion` 不变。
- 记忆钉版：`loadPinnedContext` 钉住 `listActiveFor` 的 id 与顺序（资料受限会话为空），`contextInput` 每次调用按钉住的 id 调 `getCurrent` 重读，非 active 的跳过，来源失效的照旧记 `source_scope_revoked`。记忆读取与其余钉版分开 try：读取失败时保存该错误，每次调用重抛，由 `handleContext` 阻断发送，与钉版前一致；不会因此丢掉继续来源与计划模式判定。
- 顺序：继续来源与计划说明插在当前任务输入（最后一组的首条）之前；`/context` 估算键不变。必留超预算的失败说明改为「指令/技能/记忆/继续来源/计划说明」。
- `docs/runtime.md`「上下文选择」加视图顺序与前缀成立条件，块头示例去掉版本；「计划模式」改为插在当前任务输入之前；「长期记忆（§5）」加按任务钉版一条。

测试：新增 `test/60-context-prefix.test.ts`，覆盖四项：中途 `memory_save` 的记忆下一任务才注入、中途撤销与修订下一次调用生效且顺序保持钉住时的顺序；continue 计划任务的视图为参考块 → 历史 → 继续来源 → 计划说明 → 当前任务，普通任务没有这两块；同一会话三次调用（跨任务，指令产物与技能库版本都变化）逐次为前缀；记忆钉版读取失败时阻断发送。另更新 `test/16-context-memory.test.ts`（选择器单元：块头与顺序）、`test/56-skills.test.ts`（块头、选择记录保存版本、失败说明正则）、`test/59-system-prompt.test.ts`（块头）。

未处理（评审记录）：
- 插入点沿用选择器对当前任务的定义（最后一条 user 消息所在组）。现在每个任务只有一条 user 消息，与「任务输入」一致；将来若在任务中途追加 user 消息（steering 等），两块会移到新消息之前。
- 部署后验证（工单中的 SQL）由拥有者执行。

`test/19-tui-demo.test.ts` 的失败在本工单之前已存在，与本工单无关。
