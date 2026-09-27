Status: ready-for-agent

# 斜杠命令：每个命令一个自洽的条目

## 目标

一个斜杠命令的名字、帮助、是否作为任务输入、是否回显、是否保留成功结果与处理逻辑放在同一个条目里；补全、帮助、派发、回显、结果行都从这张表推出。只做「请求 → 格式化 → 面板 / 注记」的命令不起终端就能测。来源：2026-09-26 架构审查的候选 06。

## 背景

2026-09-27 核对（main a5eea15）：

- 一个命令的知识分在六处，彼此没有编译期联系：
  1. 注册表 `SLASH_COMMANDS`（`src/tui/app.ts:646`）只有名字、说明、参数提示，供补全（:768）与帮助（:2933）。
  2. 派发 `handleCommand`（:1478–1584）27 个字符串 case；`/github` 退役提示只在 switch 里，`/thinking` 与 `/model` 共用 case。
  3. 算不算任务输入：`handleSubmit` 的 `/plan <内容>`（:1396）与 `/skill:` 前缀（:1401），`/skill <参数>` 改写（:1559）。
  4. 回显：`/quit` 以外全回显（:1482）。
  5. 保留成功结果：`event-flow.ts:358` 的正则 `/^\/(?:mode|model)(?:\s|$)/`。
  6. 处理函数的接口是整个 TuiApp。
- 处理函数分两类：
  - 「请求 → 格式化 → 面板或注记」：`new-project`、`search`、`skills`（含不带名称的 `/skill`）、`memory`、`qq`、`github`、不带内容的 `/plan`。只用当前会话、控制面请求、`showText`、`notify`，约 190 行，经 TuiApp 的测试一个都没有。
  - 其余命令动覆盖层、选择列表、分页器、编辑器、会话切换或连接批次（sessions、approvals、model、mode、resume-queue、context、prompt、expand、artifact、continue 等）。
- 测试：14 号每个测试起完整 Runtime 与假终端；27 个命令里 17 个没有经 TuiApp 的测试。
- 不一致：
  1. `/skill <名称>` 先回显 `❯ /skill x`，再显示任务输入 `❯ /skill:x`；`/plan <内容>` 只显示任务输入。
  2. 直接输入的 `/skill:<名称>` 提交未 trim 的原文（:1404），行首带空白时后台 `expandSkillCommand` 的 `/^\/skill:/` 匹配不上。
  3. `/status` 无活动任务时什么都不显示（`refreshTaskDetails` :1381；启动时 :1017 也调它）。
  4. README 命令表过期：`/mode` 写带参数（实际拒绝参数），缺 `/new`、`/model`、`/thinking`、`/prompt`、`/qq`。
  5. `docs/runtime.md:1489` 写「`/thinking` 只列出当前模型支持的档位」（issue 10 原设计）；d8c8fe7 起与 `/model` 共用面板，注册表的说明是对的。
  6. `contextBarLines`（:1844）不用 `this` 却是私有方法，54、61 号只能从原型调；内有 `void width` 与注释掉的一段。`cmdMode` 的 `current`（:1727）未用；`openHelp` 上的注释写的是「/model 与 /thinking：三列面板」。

## 决定

### 条目

新文件 `src/tui/commands.ts`，一张 `COMMANDS` 表：

```ts
interface SlashCommand {
  name: string; description: string; argumentHint?: string;
  hidden?: true;       // 不进补全与帮助（/github 退役提示）
  silent?: true;       // 不回显（/quit）
  keepsResult?: true;  // 成功结果留在命令行下（/mode、/model）；错误总是保留
  /** 整行作为任务输入时返回要提交的文本；null = 按命令执行 */
  taskInput?: (line: string) => string | null;
  run: (ctx: CommandContext, args: { rest: string[]; arg: string; line: string }) => Promise<void> | void;
}
```

从表推出：

- 补全（`SlashCommandAutocomplete` 一并搬入）与帮助的命令行：非 hidden 条目。
- 任务输入：派发前先问各条目的 `taskInput`（只有 plan、skill 有），`handleSubmit` 的三处前缀判断并进条目。
- 派发：按名字查表，查不到注记「未知命令」。
- 回显：非 silent 条目。
- 结果行：删 `event-flow.ts:358` 的正则，由派发器按 `keepsResult || isError` 决定写不写。

`/thinking` 单独一个条目，`run` 与 `/model` 相同，不设 `keepsResult`（规格：`/thinking` 不追加成功结果）。

### 处理函数与上下文

- 第一类命令整段搬进 `commands.ts`，只拿上下文 `{ view, request, notify, showText, result }`。
- 面板类命令的处理函数本身就是 TUI 组件逻辑，留在 TuiApp；条目经上下文里的 `host` 调用。`host` 是显式列出方法的接口，由 TuiApp 以对象字面量实现（方法仍是 TuiApp 私有）。
- 结果行：`host.openModelPicker(result)`、`host.openModeList(result)` 拿派发器给的 `result(text, isError)` 回调，写不写由条目决定；处理函数不再碰 `echoKey` 与 state。
- 第一类命令的错误与用法照旧走 `notify`（事件流末尾的注记），不改成挂在命令下的结果行；以后要改只动上下文一处。

### 行为变化

- `/skill <名称> [参数]` 与 `/skill:<名称>` 都由 skill 条目的 `taskInput` 认领：不回显，事件流只留 `❯ /skill:<名称>`，按 trim 过的整行提交（参数原文保留换行与空白）。不带名称的 `/skill` 仍按命令执行（列出技能库）并回显。
- `/status` 无活动任务时注记「当前没有活动任务」，只加在条目里。

### 清理与文档

- `contextBarLines` 改为模块级导出函数，删死代码；54、61 号直接 import。
- 删 `cmdMode` 的 `current` 与 `openHelp` 上错位的注释。
- README 命令表按现状重写，加测试：表里的 `/名字` 与可见条目正好一致。
- 改正 `docs/runtime.md` 的 `/thinking` 说明与 `/skill` 回显的描述。
- CONTEXT.md 不加术语（斜杠命令是 TUI 内部概念）。

### 不在本单

面板类处理函数搬出 TuiApp；search、memory、qq 等的陈旧检查（跨会话切换后照常弹面板；写操作的确认若因陈旧被丢反而让人不知道写入已发生）；控制面带类型入口与错误码分类（候选 07）；`FakeTerminal` 在 14、30、32 号的三份拷贝；TODO 的 `/expand`、「prompt 查看」。TODO 的「命令也加入事件流」：回显已在 8896fbf 进入事件流、99f282d 起按会话持久化；若指面板内容也进事件流，本单之后只改上下文的 `showText`。

## 测试

新增 65 号，用假上下文（请求只记 op 与参数、返回预设应答），不起终端与 Runtime：

1. 表的一致性：名字唯一；可见条目与补全候选、帮助行一一对应；`/github` 不进补全与帮助但可派发。
2. 派发规则：`/quit` 不回显；未知命令注记；`/plan x` 作任务输入不回显、`/plan` 显示用法并回显；（第 2 步后）`/skill x  a\nb` 提交 `/skill:x  a\nb` 不回显；`/model` 成功结果保留、`/thinking` 丢弃、任何命令的错误都保留。
3. 第一类处理函数：memory 四个子命令与版本号校验；qq 未配置、已配置、inbox 空与非空；search 无命中、有命中、不完整；skills 列表与诊断；new-project 用法、成功、失败。
4. README 命令表一致性（第 4 步）。

14 号不改，作集成测试；面板类命令不新增测试。

## 步骤

每步 `npm test` 与 `npm run typecheck` 通过后本地提交。

0. 本工单。
1. 纯搬移（行为不变）：`commands.ts` 的表、派发器、补全、帮助命令行；第一类处理函数搬入；TuiApp 实现 `host`，`handleSubmit` / `handleCommand` 收成一次派发；结果行规则挪到派发器；新增 65 号。提交前对抗式复核等价性。
2. 行为变化：`/skill` 统一为任务输入；`/status` 注记。
3. 清理：`contextBarLines` 导出与死代码；`cmdMode` 未用变量与错位注释。
4. 文档：README 命令表与一致性测试；`docs/runtime.md`；工单标记完成并追加交付记录。交付前跑变异检查。

## Comments
