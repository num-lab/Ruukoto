/**
 * 斜杠命令（架构工单 06）：每个命令一个条目，名字、帮助、是否作为任务输入、
 * 是否回显、是否保留成功结果与处理逻辑放在一起；补全、帮助、派发、回显与
 * 结果行都从 COMMANDS 推出。
 *
 * 只做「请求 → 格式化 → 面板 / 注记」的命令在本文件处理，只拿 CommandContext；
 * 面板类命令的处理逻辑是 TUI 组件逻辑，留在 TuiApp，经 CommandHost 调用。
 */

import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { requestOutcome } from "@ruukoto/control/client.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { productFromEnv } from "@ruukoto/core/product.ts";

/** ruukoto-code 不再提供旧项目写入路径（agent-direction issue 23）时的提示。 */
export const LEGACY_PROJECT_WRITE_HINT =
  "ruukoto-code 使用工作区：ruukoto-code <目录> 打开或创建工作区；旧项目只保留查看，需要时用 project migration-preview 映射到工作区";

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** 写在本条命令回显下的结果行；成功结果只在条目 keepsResult 时保留。 */
export type CommandResult = (text: string, isError?: boolean) => void;

/** 面板类命令：处理逻辑在 TuiApp。 */
export interface CommandHost {
  quit(): void;
  openHelp(): void;
  openResume(): Promise<void>;
  openProjects(): void;
  newSession(cwd: string): Promise<void>;
  newSessionHere(): Promise<void>;
  branchSession(name: string, result: CommandResult): Promise<void>;
  compactSession(prompt: string, result: CommandResult, key: string | null, line: string): Promise<void>;
  reloadHistory(): Promise<void>;
  artifact(prefix: string): Promise<void>;
  openApprovals(): void;
  interrupt(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  continueTask(taskId: string): Promise<void>;
  resumeQueue(): Promise<void>;
  openModelPicker(result: CommandResult): Promise<void>;
  openModeList(rest: string[], result: CommandResult): Promise<void>;
  /** 刷新当前活动任务详情；false = 当前会话没有活动任务。 */
  refreshTask(): Promise<boolean>;
  openContext(result: CommandResult): Promise<void>;
  openPrompts(): Promise<void>;
  toggleTodo(): void;
  openWorkflow(): void;
  openQuestions(): void;
  openProcesses(): void;
  /** 排队输入面板：逐项上移/下移、转为引导。 */
  openQueue(): void;
  /** 以当前会话提交任务输入。 */
  submit(text: string): Promise<void>;
  /** 把正文作为引导接入当前任务（/steer；错过目标回队首）。 */
  steer(text: string): Promise<void>;
}

export interface CommandContext {
  /** 发起命令时的当前会话（null = 未选择）。 */
  readonly view: { sessionId: string; projectId: string } | null;
  request<K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>>;
  /** 事件流注记（用法、错误）。 */
  notify(text: string): void;
  /** 可关闭的文本面板。 */
  showText(text: string): void;
  result: CommandResult;
  readonly host: CommandHost;
}

/** TuiApp 提供给派发器的能力：上下文之外再加回显与结果行写入。 */
export interface CommandEnv extends Omit<CommandContext, "result"> {
  /** 回显命令行，返回结果行的键（未选择会话时为 null）。 */
  echo(line: string): string | null;
  setResult(key: string | null, text: string, isError: boolean): void;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** 不进补全与帮助。 */
  hidden?: true;
  /** 不回显。 */
  silent?: true;
  /** 成功结果留在命令行下；错误总是保留。 */
  keepsResult?: true;
  /** 整行作为任务输入时返回要提交的文本；null = 按命令执行。 */
  taskInput?: (line: string) => string | null;
  run: (ctx: CommandContext, args: { rest: string[]; arg: string; line: string; key: string | null }) => Promise<void> | void;
}

/**
 * 写操作失败的提示，按请求结果分类（架构工单 07）：应答丢失时写入可能已生效，
 * 不自动重发，请拥有者先用 check 核实。
 */
export function writeFailure(action: string, err: unknown, check: string): string {
  const message = (err as Error).message;
  switch (requestOutcome(err)) {
    case "not_sent":
      return `${action}未发送：${message}`;
    case "rejected":
      return `${action}失败：${message}`;
    default:
      return `${action}结果未知：${message}；先用 ${check} 核实再操作（未自动重发）`;
  }
}

async function newProject(ctx: CommandContext, name: string): Promise<void> {
  if (productFromEnv() === "ruukoto-code") {
    ctx.notify(LEGACY_PROJECT_WRITE_HINT);
    return;
  }
  if (!name) {
    ctx.notify("用法：/new-project <名称>");
    return;
  }
  try {
    await ctx.request("create_project", { name });
    ctx.showText(`项目已创建：${name}；用 /new-session <工作目录> 创建会话`);
  } catch (err) {
    ctx.notify(red(writeFailure("创建项目", err, "/project")));
  }
}

async function search(ctx: CommandContext, query: string): Promise<void> {
  const view = ctx.view;
  if (!view) {
    ctx.notify("尚未选择会话");
    return;
  }
  if (!query) {
    ctx.notify("用法：/search <关键词>（在当前会话历史原文中做字面搜索）");
    return;
  }
  try {
    const result = await ctx.request("search_history", { query, session_id: view.sessionId, limit: 20 });
    if (result.hits.length === 0) {
      ctx.showText(`没有命中：「${query}」（扫描 ${result.scanned} 条${result.complete ? "" : "，结果不完整"}）`);
      return;
    }
    const lines = result.hits.map(
      (h) =>
        `  [${h.entryId.slice(0, 8)}] ${h.role ?? "?"} ×${h.matchCount}  ${h.snippet.replace(/\n/g, " ")}`,
    );
    ctx.showText(
      `命中 ${result.hits.length} 条（扫描 ${result.scanned} 条${result.complete ? "" : "，结果不完整，可缩小范围"}）：\n${lines.join("\n")}`,
    );
  } catch (err) {
    ctx.notify(red(`搜索失败：${(err as Error).message}`));
  }
}

/** /skills：当前技能库（任务使用各自开始时的钉版）与诊断。 */
async function skills(ctx: CommandContext): Promise<void> {
  try {
    const result = await ctx.request("list_skills", {});
    const lines = [`技能库 ${result.dir}（${result.skills.length} 个；修改从下一任务生效）`];
    for (const s of result.skills) lines.push(`  ${s.name}${s.explicitOnly ? "（仅显式调用）" : ""}  ${s.description}`);
    if (result.diagnostics.length > 0) {
      lines.push(`诊断（${result.diagnostics.length} 条）：`);
      for (const d of result.diagnostics) lines.push(`  ${d}`);
    }
    lines.push("/skill <名称> [参数] 显式调用");
    ctx.showText(lines.join("\n"));
  } catch (err) {
    ctx.notify(red(`查询失败：${(err as Error).message}`));
  }
}

async function memory(ctx: CommandContext, rest: string[]): Promise<void> {
  const sub = rest[0] ?? "list";
  const view = ctx.view;
  if (sub === "list") {
    try {
      const result = await ctx.request("list_memories", view ? { project_id: view.projectId } : {});
      if (result.memories.length === 0) {
        ctx.showText("当前项目没有记忆（代理可在任务中经 memory_save 创建；拥有者经 CLI memory save 管理）");
        return;
      }
      const lines = result.memories.map(
        (m) => `  [${m.id.slice(0, 10)}] ${m.category} v${m.currentVersion} ${m.status}${m.scope === "personal" ? "（个人共享）" : ""}  ${m.updatedAt}`,
      );
      ctx.showText(`记忆（${result.memories.length} 条）：\n${lines.join("\n")}\n/memory show <id> 查看正文与版本`);
    } catch (err) {
      ctx.notify(red(`查询失败：${(err as Error).message}`));
    }
    return;
  }
  if (sub === "show") {
    const id = rest[1];
    if (!id) {
      ctx.notify("用法：/memory show <id>");
      return;
    }
    try {
      const detail = await ctx.request("get_memory", { memory_id: id });
      const m = detail.memory;
      const history = detail.versions
        .map((v) => `  v${v.version} ${v.author} ${v.createdAt}${v.reason ? `（${v.reason}）` : ""}`)
        .join("\n");
      ctx.showText(
        `记忆 ${m.id}（${m.category}，${m.status}，当前 v${m.currentVersion}）：\n${m.content}\n版本历史：\n${history}`,
      );
    } catch (err) {
      ctx.notify(red(`查询失败：${(err as Error).message}`));
    }
    return;
  }
  if (sub === "revoke" || sub === "restore") {
    const id = rest[1];
    const versionArg = rest[2];
    if (!id || !versionArg || !/^\d+$/.test(versionArg)) {
      ctx.notify(
        sub === "revoke"
          ? "用法：/memory revoke <id> <当前版本号>（条件更新，版本不符会拒绝）"
          : "用法：/memory restore <id> <恢复自版本号>（创建新修订）",
      );
      return;
    }
    try {
      if (sub === "revoke") {
        await ctx.request("revoke_memory", { memory_id: id, expected_version: Number(versionArg) });
        ctx.showText(`记忆 ${id} 已撤销（历史版本保留可查；/memory restore 可恢复）`);
      } else {
        await ctx.request("restore_memory", { memory_id: id, from_version: Number(versionArg) });
        ctx.showText(`记忆 ${id} 已自 v${versionArg} 恢复（创建了新修订）`);
      }
    } catch (err) {
      ctx.notify(red(writeFailure(sub === "revoke" ? "撤销记忆" : "恢复记忆", err, `/memory show ${id}`)));
    }
    return;
  }
  ctx.notify("用法：/memory [list | show <id> | revoke <id> <当前版本> | restore <id> <自版本>]");
}

/**
 * QQ 群聊入口（issue 07）：连接/登录状态、群配置、启停、队列与发送结果
 * 查看。连接参数与群允许列表的修改经 CLI（ruukoto qq configure …）。
 */
async function qq(ctx: CommandContext, rest: string[]): Promise<void> {
  const sub = rest[0] ?? "status";
  try {
    if (sub === "status") {
      const s = await ctx.request("qq_status", {});
      if (!s.configured) {
        ctx.showText("QQ 入口未配置（拥有者经 CLI：ruukoto qq configure --endpoint … --self-id …）");
        return;
      }
      if (!("sessions" in s)) {
        // 适配器未启动（dev 实例或后台正在停止）：只有配置与状态说明
        ctx.showText(`QQ 入口已配置；${s.stateDetail}`);
        return;
      }
      const sessions = s.sessions.map(
        (g) => `  群 ${g.groupId}：会话 ${String(g.sessionId).slice(0, 10)}… 排队 ${g.queued}${g.active ? "，执行中" : ""}`,
      );
      ctx.showText(
        `QQ 入口：${s.enabled ? "已启用" : "已停用"}；连接 ${s.online ? `在线（账号 ${s.actualSelfId}）` : `离线（${s.stateDetail}）`}\n` +
          `端点 ${s.endpoint}；预期账号 ${s.selfId}；配置 v${s.configVersion}；允许群：${s.groups.join("、") || "（空）"}（历史值，核心群聊已退役）\n` +
          `拥有者私聊：${s.ownerUserId ?? "未开启"}（共享 main；发送记录用 ruukoto notify list 查看）\n` +
          (sessions.length ? `旧群会话归档：\n${sessions.join("\n")}` : "  （无旧群会话）"),
      );
      return;
    }
    if (sub === "enable" || sub === "disable") {
      const verb = sub === "enable" ? "启用" : "停用";
      const c = await ctx.request("qq_set_enabled", { enabled: sub === "enable" }).catch((err: unknown) => {
        ctx.notify(red(writeFailure(`QQ 入口${verb}`, err, "/qq")));
        return null;
      });
      if (c) ctx.showText(`QQ 入口已${verb}（配置 v${c.configVersion}）`);
      return;
    }
    if (sub === "groups") {
      const s = await ctx.request("qq_status", {});
      ctx.showText(
        `允许的群：${("groups" in s ? s.groups : []).join("、") || "（空）"}（历史值）\n` +
          "核心群聊已退役，不再维护允许群（正式 QQ 群聊外挂将在后续阶段交付）",
      );
      return;
    }
    if (sub === "inbox" || sub === "outbox") {
      const params = { group_id: rest[1], limit: 20 };
      const lines =
        sub === "inbox"
          ? (await ctx.request("qq_inbox_list", params)).entries.map(
              (e) => `  群 ${e.groupId} ${e.userId}：${String(e.text).slice(0, 40)} [${e.status}${e.recalled ? "/已撤回" : ""}] ${e.createdAt}`,
            )
          : (await ctx.request("qq_outbox_list", params)).entries.map(
              (e) => `  群 ${e.groupId}：${String(e.text).slice(0, 40)} [${e.status}]${e.error ? ` ${String(e.error).slice(0, 60)}` : ""} ${e.createdAt}`,
            );
      if (lines.length === 0) {
        ctx.showText(sub === "inbox" ? "暂无收件登记" : "暂无发送记录");
        return;
      }
      ctx.showText(`${sub === "inbox" ? "收件登记" : "发送记录"}（最近 ${lines.length} 条）：\n${lines.join("\n")}`);
      return;
    }
    ctx.notify("用法：/qq [status | enable | disable | groups | inbox [群号] | outbox [群号]]");
  } catch (err) {
    ctx.notify(red(`QQ 操作失败：${(err as Error).message}`));
  }
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: "quit", description: "退出", silent: true, run: (ctx) => ctx.host.quit() },
  { name: "help", description: "命令与快捷键说明", run: (ctx) => ctx.host.openHelp() },
  { name: "todo", description: "打开或关闭工作清单", run: (ctx) => ctx.host.toggleTodo() },
  { name: "resume", description: "切换当前项目的会话", run: (ctx) => ctx.host.openResume() },
  { name: "project", description: "切换项目", run: (ctx) => ctx.host.openProjects() },
  { name: "new-project", description: "创建项目", argumentHint: "<名称>", run: (ctx, { arg }) => newProject(ctx, arg) },
  { name: "new-session", description: "在当前项目创建会话", argumentHint: "<工作目录>", run: (ctx, { arg }) => ctx.host.newSession(arg) },
  { name: "new", description: "在当前工作区创建会话", run: (ctx) => ctx.host.newSessionHere() },
  { name: "branch", description: "从当前会话的已落盘历史建立独立会话", argumentHint: "[名称]", keepsResult: true,
    run: (ctx, { line }) => ctx.host.branchSession(line.replace(/^\/branch\s*/, ""), ctx.result) },
  { name: "compact", description: "主动压缩当前会话上下文", argumentHint: "[prompt]", keepsResult: true,
    run: (ctx, { line, key }) => ctx.host.compactSession(line.replace(/^\/compact\s*/, ""), ctx.result, key, line) },
  { name: "history", description: "重新加载当前会话历史", run: (ctx) => ctx.host.reloadHistory() },
  { name: "artifact", description: "查看工具产物正文", argumentHint: "<产物 id 前缀>", run: (ctx, { arg }) => ctx.host.artifact(arg) },
  { name: "approvals", description: "待处理审批列表", run: (ctx) => ctx.host.openApprovals() },
  { name: "interrupt", description: "中断当前任务或手动压缩", argumentHint: "[taskId]", run: (ctx, { arg }) => ctx.host.interrupt(arg) },
  { name: "cancel", description: "取消排队/活动任务", argumentHint: "<taskId>", run: (ctx, { arg }) => ctx.host.cancel(arg) },
  { name: "model", description: "切换模型", keepsResult: true, run: (ctx) => ctx.host.openModelPicker(ctx.result) },
  { name: "continue", description: "继续已中断任务", argumentHint: "[taskId]", run: (ctx, { arg }) => ctx.host.continueTask(arg) },
  { name: "resume-queue", description: "恢复已暂停的会话队列", run: (ctx) => ctx.host.resumeQueue() },
  { name: "queue", description: "查看排队输入，逐项上移/下移或转为引导", run: (ctx) => ctx.host.openQueue() },
  { name: "steer", description: "把正文作为引导接入当前任务的下一边界", argumentHint: "<正文>",
    run: async (ctx, { arg }) => {
      if (!arg) { ctx.notify("用法：/steer <正文>（引导接入当前任务；错过目标回到队首）"); return; }
      await ctx.host.steer(arg);
    } },
  { name: "mode", description: "选择当前会话的默认模式", keepsResult: true, run: (ctx, { rest }) => ctx.host.openModeList(rest, ctx.result) },
  {
    name: "status",
    description: "刷新并查看当前任务详情",
    run: async (ctx) => {
      if (!(await ctx.host.refreshTask())) ctx.notify("当前没有活动任务");
    },
  },
  { name: "search", description: "搜索会话历史原文", argumentHint: "<关键词>", run: (ctx, { arg }) => search(ctx, arg) },
  { name: "memory", description: "长期记忆", argumentHint: "<子命令>", run: (ctx, { rest }) => memory(ctx, rest) },
  { name: "context", description: "查看当前上下文窗口", keepsResult: true, run: (ctx) => ctx.host.openContext(ctx.result) },
  {
    name: "skill",
    description: "调用技能",
    argumentHint: "<名称> [参数]",
    // /skill <名称> [参数] 与 /skill:<名称> 都是任务输入，统一按 /skill:<名称> 提交
    // （参数取原文，保留换行与空白；失败恢复草稿后可直接重发）；不带名称时列出技能库
    taskInput: (line) =>
      line.startsWith("/skill:") ? line : /^\/skill\s+\S/.test(line) ? `/skill:${line.slice("/skill".length).trim()}` : null,
    run: (ctx) => skills(ctx),
  },
  { name: "skills", description: "查看技能库与诊断", run: (ctx) => skills(ctx) },
  { name: "processes", description: "查看本会话后台、日志与停止", run: ctx => ctx.host.openProcesses() },
  { name: "questions", description: "查看拥有者问题，逐题回答或取消", run: ctx => ctx.host.openQuestions() },
  { name: "workflow", description: "打开工作流侧栏，选择运行、启动与控制", run: (ctx) => ctx.host.openWorkflow() },
  { name: "prompt", description: "查看本会话模型请求列表与每次调用的 prompt 详情", run: (ctx) => ctx.host.openPrompts() },
  { name: "qq", description: "QQ 群聊入口：status | enable | disable | groups | inbox | outbox", argumentHint: "<子命令>", run: (ctx, { rest }) => qq(ctx, rest) },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** 补全与帮助按名称列出的命令。 */
export const VISIBLE_COMMANDS = COMMANDS.filter((c) => !c.hidden).sort((a, b) => a.name.localeCompare(b.name));

/** 帮助页的命令行。 */
export function commandHelpLines(): string[] {
  return VISIBLE_COMMANDS.map((c) => `  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}`);
}

/** 输入框提交：任务输入交给 host.submit，其余 / 开头的按命令执行。 */
export async function dispatchInput(text: string, env: CommandEnv): Promise<void> {
  const line = text.trim();
  if (line.length === 0) return;
  for (const command of COMMANDS) {
    const input = command.taskInput?.(line);
    if (input != null) {
      await env.host.submit(input);
      return;
    }
  }
  if (!line.startsWith("/")) {
    await env.host.submit(text);
    return;
  }
  const [name = "", ...rest] = line.slice(1).split(/\s+/);
  const command = BY_NAME.get(name);
  // 命令回显进事件流（❯ /mode + 完成后的 ⎿ 结果行）
  const key = command?.silent ? null : env.echo(line);
  if (!command) {
    env.notify(`未知命令：/${name}（/help 查看命令列表）`);
    return;
  }
  const result: CommandResult = (resultText, isError = false) => {
    if (isError || command.keepsResult) env.setResult(key, resultText, isError);
  };
  await command.run(
    { view: env.view, request: env.request, notify: env.notify, showText: env.showText, result, host: env.host },
    { rest, arg: rest.join(" ").trim(), line, key },
  );
}

/** 只做固定操作（斜杠命令）的补全；不扫描拥有者本地文件。 */
export class SlashCommandAutocomplete implements AutocompleteProvider {
  readonly triggerCharacters = ["/"];
  constructor(private readonly commands: ReadonlyArray<{ name: string; description?: string; argumentHint?: string }>) {}

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
    if (cursorLine !== 0) return null;
    const line = lines[0] ?? "";
    if (!line.startsWith("/") || cursorCol > line.length) return null;
    const token = line.slice(0, cursorCol);
    if (/\s/.test(token)) return null;
    const items: AutocompleteItem[] = this.commands
      .filter((c) => `/${c.name}`.startsWith(token))
      .map((c) => ({
        value: `/${c.name}`,
        label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
        description: c.description,
      }));
    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  applyCompletion(lines: string[], cursorLine: number, _cursorCol: number, item: AutocompleteItem, prefix: string) {
    const line = lines[cursorLine]!;
    const rest = line.slice(prefix.length);
    const next = `${item.value} ${rest}`.replace(/\s+$/, " ");
    const newLines = [...lines];
    newLines[cursorLine] = next;
    return { lines: newLines, cursorLine, cursorCol: item.value.length + 1 };
  }

  shouldTriggerFileCompletion(): boolean {
    return false;
  }
}
