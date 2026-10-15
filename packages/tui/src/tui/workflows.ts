import { workflowStatus } from "@ruukoto/view/workflow-status.ts";
/** 工作流侧栏只保存导航与未决提交；运行事实始终重新查询后台。
 * Note: 见 .agents/notes/implemented/feature/2026-10-14-workflow-progressive-controls.md
 */
import { Input, SelectList, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type SelectItem, type SelectListTheme, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import { requestOutcome } from "@ruukoto/control/client.ts";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { WorkflowControl } from "@ruukoto/core/workflow.ts";
import type { AgentWaitView } from "@ruukoto/core/agent-wait.ts";
import { compileWorkflowOutput } from "@ruukoto/agent/workflow-output.ts";
import { TwoLineSelectList } from "./session-list.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

type Detail = OpResult<"workflow_get">;
type Run = Detail["run"];
type WriteOp = "workflow_start" | "workflow_answer" | "workflow_control";
type Choice = SelectItem & { pick: () => void };
interface Screen {
  title: string;
  text: string;
  choices: Choice[];
  list?: SelectList;
  input?: Input;
  reload?: () => Promise<void>;
  twoLine?: boolean;
  scroll: number;
  revision: number;
  requestId?: string;
}
interface SidebarDeps {
  request: ControlConnection["request"];
  pending: PendingRequestStore;
  sessionId: () => string | null;
  instanceId: () => string | null;
  online: () => boolean;
  rows: () => number;
  render: () => void;
  close: () => void;
  approvals: () => void;
  wait?: () => AgentWaitView | undefined;
}
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const theme: SelectListTheme = {
  selectedPrefix: text => `\x1b[36m${text}\x1b[0m`, selectedText: text => `\x1b[1m${text}\x1b[0m`,
  description: dim, scrollInfo: dim, noMatch: dim,
};
const clean = (text: string) => sanitizeForDisplay(text);
const line = (text: string) => clean(text).replace(/\s+/g, " ");
const terminal = (status: string) => ["succeeded", "partial", "failed", "canceled"].includes(status);

function time(at: string): string { return at.replace("T", " ").replace(/Z$/, " UTC"); }
function runName(run: Run): string { return run.displayName || `未命名工作流 · ${time(run.createdAt)}`; }
function runText(detail: Detail): string {
  const run = detail.run;
  return [`${runName(run)} · 第 ${run.number} 项`, `${workflowStatus(run.status)} · ${time(run.createdAt)}`, run.description ?? "",
    `尝试 ${run.attempts}/${run.maxAttempts} · 用时 ${Math.round(run.usedMs / 1000)}/${Math.round(run.durationMs / 1000)} 秒`,
    run.reason ? `当前原因：${run.reason}` : "",
    run.stopUnverified ? "停止待核实：保留占用与成果" : "",
    !run.clockVerified ? "运行计时待核实" : "",
    run.effectUnknown ? "效果未知：请先核实已发生的操作，不自动重做" : "",
    `最终回报：${({ pending: "待送达", queued: "排队中", reporting: "正在汇总", reported: "已登记", undelivered: "未送达" } as Record<string, string>)[run.delivery?.status ?? ""] ?? run.delivery?.status ?? "尚未登记"}`,
  ].filter(Boolean).join("\n");
}

export class WorkflowSidebar implements Component {
  opened = false;
  focused = false;
  private screens: Screen[] = [];
  private message = "";
  private session: string | null = null;
  private instance: string | null = null;
  private readonly inFlight = new Set<string>();
  private readonly verifying = new Set<string>();
  private readonly unreceived = new Set<string>();
  private readonly loading = new Set<Screen>();
  private readonly reloadAgain = new Set<Screen>();
  private visibleItems = 0;
  private textRows = 0;
  private allTextRows = 0;
  private listTop = 0;

  constructor(private readonly deps: SidebarDeps) {}
  invalidate(): void {}
  private get screen(): Screen | undefined { return this.screens.at(-1); }

  open(): void {
    const previous = this.screen;
    this.opened = true;
    this.sessionChanged();
    if (!this.screen) this.root();
    else if (this.screen === previous && this.screen.reload) void this.screen.reload();
    this.deps.render();
  }
  sessionChanged(): void {
    const session = this.deps.sessionId(), instance = this.deps.instanceId();
    if (session === this.session && instance === this.instance) return;
    this.session = session; this.instance = instance;
    this.screens = []; this.message = ""; this.unreceived.clear();
    if (this.opened) this.root();
  }
  refresh(): void {
    this.sessionChanged();
    const screen = this.screen;
    if (this.opened && screen?.reload) void screen.reload();
  }
  async reconnect(): Promise<void> {
    this.sessionChanged();
    const saved = this.deps.pending.list();
    if (saved.corrupt.length) this.message = `有 ${saved.corrupt.length} 条待核实记录损坏，原文件已保留；请从待核实操作查看。`;
    for (const record of saved.records) await this.verify(record);
    this.refresh();
  }
  private push(title: string, text = ""): Screen {
    const screen: Screen = { title, text, choices: [], scroll: 0, revision: 0 };
    this.screens.push(screen); this.message = ""; this.deps.render();
    return screen;
  }
  private choices(screen: Screen, choices: Choice[], twoLine = false): void {
    const selected = screen.list?.getSelectedItem()?.value;
    screen.choices = choices; screen.twoLine = twoLine;
    screen.list = undefined;
    this.buildList(screen, selected);
    this.deps.render();
  }
  private buildList(screen: Screen, selected?: string): void {
    const count = Math.max(1, this.visibleItems || 5);
    const items = screen.choices.map(choice => ({ value: choice.value, label: line(choice.label), description: line(choice.description ?? "") }));
    const list = screen.twoLine ? new TwoLineSelectList(items, count, theme) : new SelectList(items, count, theme);
    const index = items.findIndex(item => item.value === selected);
    if (index >= 0) list.setSelectedIndex(index);
    list.onSelect = item => screen.choices.find(choice => choice.value === item.value)?.pick();
    list.onCancel = () => this.back();
    screen.list = list;
  }
  private async load(screen: Screen, read: () => Promise<void>): Promise<void> {
    if (this.loading.has(screen)) { this.reloadAgain.add(screen); return; }
    this.loading.add(screen);
    const revision = ++screen.revision;
    try { await read(); }
    catch (error) {
      if (revision === screen.revision && this.screens.includes(screen)) this.message = `查询失败：${(error as Error).message}；按 r 重新查询。`;
    }
    this.loading.delete(screen);
    if (this.reloadAgain.delete(screen) && this.screens.includes(screen)) void screen.reload?.();
    this.deps.render();
  }
  private root(): void {
    const screen = this.push("当前会话 · 活动与最近结果");
    this.runs(screen, "current", 0);
  }
  private runs(screen: Screen, scope: "current" | "history", offset: number): void {
    const sessionId = this.session, instanceId = this.instance;
    screen.reload = () => this.load(screen, async () => {
      const page = sessionId ? await this.deps.request("workflow_list", { session_id: sessionId, scope, offset, limit: 20 }) : { runs: [], total: 0, nextOffset: null };
      if (sessionId !== this.session || instanceId !== this.instance || !this.screens.includes(screen)) return;
      const selected = screen.list?.getSelectedItem()?.value;
      let retained: Run | undefined;
      if (selected && !selected.startsWith("$") && !page.runs.some(run => run.id === selected)) {
        retained = (await this.deps.request("workflow_get", { run_id: selected })).run;
        if (sessionId !== this.session || instanceId !== this.instance || !this.screens.includes(screen)) return;
      }
      screen.text = !sessionId ? "请先选择会话。" : page.total ? `共 ${page.total} 项 · 当前 ${offset + 1}–${offset + page.runs.length}` : "当前没有工作流运行。";
      const wait = this.deps.wait?.();
      if (scope === "current" && wait) screen.text += `\n${wait.phase === "reacquiring" ? "等待执行资源" : wait.phase === "waiting" ? "主 Agent 正在等待后台结果" : wait.phase === "ended" && wait.reason === "owner_input" ? "新输入已打断等待，后台工作继续" : "主 Agent 对话阶段"}：${wait.targets.map(target => `${target.label}（${target.kind === "workflow" ? workflowStatus(target.status) : target.status}）`).join("、")}`;
      const choices: Choice[] = [...(retained ? [retained] : []), ...page.runs].map(run => ({ value: run.id, label: `${workflowStatus(run.status)} · ${runName(run)}`,
        description: `第 ${run.number} 项 · ${time(run.createdAt)}${run.description ? " · " + run.description : ""}${run.id === retained?.id ? " · 移出当前页，保留选择" : ""}`, pick: () => this.detail(run.id) }));
      if (page.nextOffset !== null) choices.push({ value: "$next", label: "下一页运行 →", pick: () => this.runs(screen, scope, page.nextOffset!) });
      if (offset > 0) choices.push({ value: "$previous", label: "← 上一页运行", pick: () => this.runs(screen, scope, Math.max(0, offset - 20)) });
      if (scope === "current" && sessionId) choices.push(
        { value: "$history", label: "历史", description: "全部历史运行，按页查看", pick: () => this.runs(this.push("历史"), "history", 0) },
        { value: "$start", label: "启动工作流", description: "选择已保存定义并填写业务参数", pick: () => this.definitions(0) });
      const pending = this.deps.pending.list();
      if (pending.records.length || pending.corrupt.length) choices.push({ value: "$pending", label: "待核实操作", description: `${pending.records.length} 项提交 · ${pending.corrupt.length} 条损坏记录`, pick: () => this.pendingList() });
      this.choices(screen, choices, true);
    });
    void screen.reload();
  }
  private detail(runId: string, stepOffset = 0): void {
    const screen = this.push("运行详情");
    screen.reload = () => this.load(screen, async () => {
      const detail = await this.deps.request("workflow_get", { run_id: runId, step_offset: stepOffset });
      if (!this.screens.includes(screen)) return;
      const run = detail.run;
      screen.text = runText(detail);
      const choices: Choice[] = [
        { value: "steps", label: "步骤与结果", pick: () => this.steps(runId, 0) },
        { value: "logs", label: "阶段日志", pick: () => this.page("阶段日志", "workflow_logs", { run_id: runId }, 0) },
      ];
      for (const step of detail.steps.filter(step => step.question === "pending")) choices.push({ value: `answer:${step.key}`, label: `回答问题 · ${step.key}`, pick: () => this.question(runId, step.key) });
      if (detail.nextStepOffset !== null) choices.push({ value: "more", label: "后续步骤与问题 →", pick: () => this.detail(runId, detail.nextStepOffset!) });
      if (!terminal(run.status)) {
        if (run.status !== "paused") choices.push({ value: "pause", label: "暂停", pick: () => this.control(detail, { action: "pause" }) });
        else choices.push({ value: "resume", label: "恢复", pick: () => this.resume(detail) });
        choices.push({ value: "cancel", label: "取消运行", pick: () => this.control(detail, { action: "cancel" }) },
          { value: "budget", label: "调整预算", pick: () => this.budget(detail) });
      }
      choices.push({ value: "approvals", label: "查看工具审批", pick: () => this.deps.approvals() },
        { value: "diagnostics", label: "诊断详情", pick: () => {
          const diagnostic = this.push("诊断详情", `${runText(detail)}\n运行 ID：${run.id}\n版本：${run.version}\n定义：${run.definitionId}\n脚本摘要：${run.scriptDigest}\n参数摘要：${run.inputDigest}\n${detail.executions.map(execution => `执行 ${execution.taskId} · ${execution.status} · 停止核实 ${execution.stopVerified ?? "尚无结论"}`).join("\n")}`);
          this.choices(diagnostic, [{ value: "back", label: "返回详情", pick: () => this.back() }]);
        } });
      this.choices(screen, choices);
    });
    void screen.reload();
  }
  private steps(runId: string, offset: number): void {
    const screen = this.push("步骤与结果");
    screen.reload = () => this.load(screen, async () => {
      const detail = await this.deps.request("workflow_get", { run_id: runId, step_offset: offset });
      if (!this.screens.includes(screen)) return;
      screen.text = `步骤 ${offset + 1}–${offset + detail.steps.length} / ${detail.totalSteps}`;
      const choices: Choice[] = detail.steps.map(step => ({ value: step.key, label: `${step.key} · ${step.status}`, description: `${step.kind} · ${step.attempts} 次尝试${step.question === "pending" ? " · 待回答" : ""}`, pick: () => {
        if (step.question === "pending") this.question(runId, step.key);
        else this.page("步骤结果", "workflow_step", { run_id: runId, step_key: step.key }, 0);
      } }));
      if (detail.nextStepOffset !== null) choices.push({ value: "$next", label: "下一页步骤 →", pick: () => { this.screens.pop(); this.steps(runId, detail.nextStepOffset!); } });
      if (offset > 0) choices.push({ value: "$previous", label: "← 上一页步骤", pick: () => { this.screens.pop(); this.steps(runId, Math.max(0, offset - 100)); } });
      this.choices(screen, choices, true);
    });
    void screen.reload();
  }
  private page<K extends "workflow_logs" | "workflow_step">(title: string, op: K, params: OpParams<K>, offset: number): void {
    const screen = this.push(title);
    screen.reload = () => this.load(screen, async () => {
      const page = await this.deps.request(op, { ...params, offset, length: 4096 });
      if (!this.screens.includes(screen)) return;
      const end = page.offset + Buffer.byteLength(page.text);
      screen.text = `${page.text}\n（字节 ${page.offset}–${end} / ${page.totalBytes}）`;
      this.choices(screen, [...(end < page.totalBytes ? [{ value: "next", label: "续读下一页 →", pick: () => this.page(title, op, params, end) }] : []),
        { value: "back", label: "返回上一层", pick: () => this.back() }]);
    });
    void screen.reload();
  }
  private definitions(offset: number): void {
    const screen = this.push("选择已保存定义");
    screen.reload = () => this.load(screen, async () => {
      const page = await this.deps.request("workflow_definitions", { offset, limit: 20 });
      if (!this.screens.includes(screen)) return;
      screen.text = page.total ? `共 ${page.total} 个定义` : "没有已保存定义；请让 Agent 保存工作流，或编辑工作流文件。";
      const choices: Choice[] = page.definitions.map(def => ({ value: def.name, label: def.name, description: def.error ?? "填写参数并确认启动", pick: () => {
        if (def.error) { this.message = `定义不可用：${def.error}；请修复定义文件后重新选择。`; this.deps.render(); return; }
        this.input("业务参数", "填写 JSON 参数；默认 {}。脚本编辑通过文件或 Agent 完成。", "{}", value => {
          let input: unknown;
          try { input = JSON.parse(value); }
          catch (error) { this.message = `JSON 格式不正确：${(error as Error).message}；请在当前输入中修正。`; this.deps.render(); return; }
          this.input("简短任务说明", "可留空；说明会显示在运行列表，不会从业务参数自动生成。", "", rawDescription => {
            const description = rawDescription.trim();
            if (description.length > 240 || /[\r\n]/.test(description)) { this.message = "说明须为一行且不超过 240 字。"; this.deps.render(); return; }
            this.confirm("确认启动", `${def.name}\n${description || "未填写说明"}\n业务参数：${JSON.stringify(input)}`, () => void this.submit("workflow_start", {
              session_id: this.session!, name: def.name, request_id: randomUUID(), input, ...(description.trim() ? { description } : {}),
            }));
          });
        });
      } }));
      if (page.nextOffset !== null) choices.push({ value: "$next", label: "下一页定义 →", pick: () => { this.screens.pop(); this.definitions(page.nextOffset!); } });
      if (offset > 0) choices.push({ value: "$previous", label: "← 上一页定义", pick: () => { this.screens.pop(); this.definitions(Math.max(0, offset - 20)); } });
      this.choices(screen, choices, true);
    });
    void screen.reload();
  }
  private input(title: string, text: string, initial: string, submit: (value: string) => void): void {
    const screen = this.push(title, text);
    const input = new Input({ prompt: "> " }); input.setValue(initial); input.handleInput("\x05");
    input.onSubmit = submit; input.onEscape = () => this.back(); screen.input = input;
    this.deps.render();
  }
  private confirm(title: string, text: string, action: () => void): void {
    const screen = this.push(title, text);
    this.choices(screen, [{ value: "confirm", label: title, pick: action }, { value: "back", label: "返回修改", pick: () => this.back() }]);
  }
  private question(runId: string, stepKey: string): void {
    const screen = this.push("回答业务问题");
    screen.reload = () => this.load(screen, async () => {
      const question = await this.deps.request("workflow_question", { run_id: runId, step_key: stepKey });
      if (!this.screens.includes(screen)) return;
      screen.text = `${question.text}\n业务回答不批准工具。`;
      if (question.status !== "pending") { this.choices(screen, [{ value: "back", label: "问题已失效，返回查看最新状态", pick: () => this.back() }]); return; }
      const validate = question.schema === undefined ? null : compileWorkflowOutput(question.schema);
      const answer = (value: unknown) => {
        if (validate && !validate(value)) { this.message = "回答不满足问题约束，请重新选择或在当前输入中修正。"; this.deps.render(); return; }
        this.confirm("确认回答", `${screen.text}\n回答：${JSON.stringify(value)}`, () => void this.submit("workflow_answer", {
          run_id: runId, step_key: stepKey, run_version: question.runVersion, question_version: question.version, request_id: randomUUID(), answer: value,
        }));
      };
      if (question.choices?.length) this.choices(screen, question.choices.map((value, index) => ({ value: String(index), label: value, pick: () => answer(value) })));
      else this.choices(screen, [{ value: "answer", label: "填写回答", pick: () => this.input("填写业务回答", question.schema ? `按约束填写 JSON：${JSON.stringify(question.schema)}` : "填写业务回答；普通文字直接输入，对象、数字或布尔值可用 JSON。", "", value => {
        if (question.schema) {
          let parsed: unknown;
          try { parsed = JSON.parse(value); }
          catch (error) { this.message = `JSON 格式不正确：${(error as Error).message}`; this.deps.render(); return; }
          answer(parsed);
        } else {
          let parsed: unknown = value;
          try { parsed = JSON.parse(value); }
          catch { /* 普通文字是有效业务回答，保留原文。 */ }
          answer(parsed);
        }
      }) }]);
      const end = question.offset + Buffer.byteLength(question.text);
      if (end < question.totalBytes) this.choices(screen, [...screen.choices, { value: "more", label: "续读完整问题 →", pick: () => this.questionPage(runId, stepKey, end) }]);
    });
    void screen.reload();
  }
  private questionPage(runId: string, stepKey: string, offset: number): void {
    const screen = this.push("业务问题续页");
    screen.reload = () => this.load(screen, async () => {
      const page = await this.deps.request("workflow_question", { run_id: runId, step_key: stepKey, offset });
      if (!this.screens.includes(screen)) return;
      screen.text = page.text;
      const end = page.offset + Buffer.byteLength(page.text);
      this.choices(screen, [...(end < page.totalBytes ? [{ value: "next", label: "续读下一页 →", pick: () => this.questionPage(runId, stepKey, end) }] : []), { value: "back", label: "返回回答", pick: () => this.back() }]);
    });
    void screen.reload();
  }
  private control(detail: Detail, control: WorkflowControl): void {
    const label = { pause: "确认暂停", resume: "确认恢复", cancel: "确认取消", budget: "确认调整预算" }[control.action];
    this.confirm(label, `${runText(detail)}\n${control.action === "budget" ? `新预算：${control.maxAttempts} 次尝试 · ${control.durationMs / 60000} 分钟\n` : ""}${control.action === "cancel" ? "取消会保留成果；停止待核实时仍保留占用，已发生效果不会撤回。" : "操作以当前运行状态为准；状态变化后需重新确认。"}`, () => void this.submit("workflow_control", {
      run_id: detail.run.id, expected_version: detail.run.version, request_id: randomUUID(), control,
    }));
  }
  private resume(detail: Detail): void {
    const verifyStops = () => {
      if (detail.run.stopUnverified) {
        this.confirm("已核实所有执行停止", "请先独立核实脚本、命令和外部操作已停止；未核实请返回并保留占用。", () => this.control(detail, { action: "resume", clockConfirmed: true, stopsConfirmed: true }));
      } else this.control(detail, { action: "resume", clockConfirmed: true });
    };
    if (!detail.run.clockVerified) this.confirm("已核实运行时间", "后台重启后的运行时间需要核实；确认后恢复原有预算计时。", verifyStops);
    else verifyStops();
  }
  private budget(detail: Detail): void {
    this.input("尝试上限", "填写正整数。已执行的尝试不会清除。", String(detail.run.maxAttempts), value => {
      const maxAttempts = Number(value);
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) { this.message = "尝试上限须为正整数。"; this.deps.render(); return; }
      this.input("运行时限（分钟）", "填写大于零的分钟数，人工等待不计时。", String(detail.run.durationMs / 60000), minutes => {
        const durationMs = Number(minutes) * 60000;
        if (!Number.isSafeInteger(durationMs) || durationMs < 1) { this.message = "运行时限须为有效的正数分钟。"; this.deps.render(); return; }
        this.control(detail, { action: "budget", maxAttempts, durationMs });
      });
    });
  }
  private async submit<K extends WriteOp>(op: K, params: OpParams<K>): Promise<void> {
    const instanceId = this.deps.instanceId();
    if (!instanceId || !this.deps.online()) { this.message = "尚未连接后台；连接后重新确认业务动作。"; this.deps.render(); return; }
    const same = this.deps.pending.list().records.find(record => record.instanceId === instanceId && (op === "workflow_start"
      ? record.op === op && record.params.session_id === (params as OpParams<"workflow_start">).session_id && record.params.name === (params as OpParams<"workflow_start">).name
      : record.params.run_id === (params as OpParams<"workflow_control">).run_id));
    if (same) { this.pendingDetail(same); return; }
    const record: PendingRequest = { op, params, requestId: params.request_id, instanceId, createdAt: new Date().toISOString() };
    try { this.deps.pending.save(record); }
    catch (error) { this.message = `待核实记录保存失败，操作未发送：${(error as Error).message}；修复客户端存储后重新确认。`; this.deps.render(); return; }
    if (this.screen) this.screen.requestId = record.requestId;
    await this.send(record);
  }
  private accepted(record: PendingRequest): void {
    this.deps.pending.clear(record.requestId); this.unreceived.delete(record.requestId);
    if (this.owns(record)) {
      this.screens = []; this.root();
      this.message = "已按原提交核实：后台已接收，未重复发送。";
    }
    else this.refresh();
  }
  private owns(record: PendingRequest): boolean { return record.instanceId === this.instance && this.screens.some(screen => screen.requestId === record.requestId); }
  private async send(record: PendingRequest): Promise<void> {
    if (record.instanceId !== this.deps.instanceId() || !this.deps.online() || this.inFlight.has(record.requestId)) return;
    this.inFlight.add(record.requestId); this.message = "正在提交；请稍候。"; this.deps.render();
    try {
      if (record.op === "workflow_start") await this.deps.request("workflow_start", record.params as OpParams<"workflow_start">);
      else if (record.op === "workflow_answer") await this.deps.request("workflow_answer", record.params as OpParams<"workflow_answer">);
      else if (record.op === "workflow_control") await this.deps.request("workflow_control", record.params as OpParams<"workflow_control">);
      else return;
      this.accepted(record);
    } catch (error) {
      const outcome = requestOutcome(error);
      if (outcome === "rejected") {
        this.deps.pending.clear(record.requestId);
        if (!this.owns(record)) return;
        if (typeof record.params.run_id === "string") {
          this.screens = []; this.root(); this.detail(record.params.run_id);
        }
        this.message = `后台明确拒绝：${(error as Error).message}；请查看最新状态，再选择并确认业务动作。`;
      } else {
        if (this.owns(record)) this.message = "提交尚未核实；原请求已保留，不会自动重做。请进入待核实操作查询。";
        if (this.deps.online()) await this.verify(record);
      }
    } finally { this.inFlight.delete(record.requestId); this.deps.render(); }
  }
  private async verify(record: PendingRequest): Promise<void> {
    if (!this.deps.online() || record.instanceId !== this.deps.instanceId() || this.verifying.has(record.requestId)) return;
    this.verifying.add(record.requestId);
    try {
      const found = record.op === "workflow_start"
        ? await this.deps.request("workflow_find", { session_id: String(record.params.session_id), request_id: record.requestId })
        : await this.deps.request("workflow_receipt", { run_id: String(record.params.run_id), request_id: record.requestId, operation: record.op as "workflow_answer" | "workflow_control" });
      if (record.instanceId !== this.deps.instanceId()) return;
      if (found) this.accepted(record);
      else { this.unreceived.add(record.requestId); if (this.owns(record)) this.message = "原提交尚未登记；可选择以原请求重试，参数保持原样。"; }
    } catch (error) { if (this.owns(record)) this.message = `核实未完成：${(error as Error).message}；原请求已保留。`; }
    finally { this.verifying.delete(record.requestId); this.deps.render(); }
  }
  private pendingList(): void {
    const screen = this.push("待核实操作");
    const saved = this.deps.pending.list();
    screen.text = saved.corrupt.length ? `损坏记录已保留：${saved.corrupt.join("、")}；请核实原后台结果及客户端文件。` : "仅查询原提交；未知结果不会自动重做。";
    this.choices(screen, saved.records.map(record => ({ value: record.requestId, label: `${record.op === "workflow_start" ? "启动" : record.op === "workflow_answer" ? "回答" : "运行控制"} · ${time(record.createdAt)}`, description: record.instanceId === this.instance ? "核实原请求" : "属于其他数据实例，保留待核实", pick: () => this.pendingDetail(record) })), true);
  }
  private pendingDetail(record: PendingRequest): void {
    const screen = this.push("核实原提交");
    screen.requestId = record.requestId;
    const refresh = () => {
      const foreign = record.instanceId !== this.deps.instanceId();
      screen.text = foreign ? "这项操作属于其他数据实例，原记录已保留。请连接原实例核实；不会向当前数据库重发。" : "原键与完整参数已保留；先查询接收回执，再决定是否按原请求重试。";
      this.choices(screen, foreign ? [{ value: "back", label: "返回", pick: () => this.back() }] : [
        { value: "verify", label: "查询原提交", pick: () => { void this.verify(record).then(() => {
          if (!this.screens.includes(screen)) return;
          if (!this.deps.pending.list().records.some(item => item.requestId === record.requestId)) { this.screens = []; this.root(); }
          else refresh();
        }); } },
        ...(this.unreceived.has(record.requestId) ? [{ value: "retry", label: "按原请求重试", pick: () => { this.confirm("确认按原请求重试", "只使用保留的原键与原参数，不创建第二项操作。", () => void this.send(record)); } }] : []),
      ]);
    };
    refresh();
  }
  private back(): void {
    if (this.screens.length <= 1) { this.opened = false; this.deps.close(); return; }
    this.screens.pop(); this.message = "";
    if (this.screen?.reload) void this.screen.reload();
    this.deps.render();
  }
  handleInput(data: string): void {
    const screen = this.screen;
    if (!screen) return;
    if (matchesKey(data, "escape")) { this.back(); return; }
    if (screen.input) { screen.input.handleInput(data); this.deps.render(); return; }
    if (data === "q") { this.back(); return; }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      screen.scroll = Math.max(0, Math.min(Math.max(0, this.allTextRows - this.textRows), screen.scroll + (matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, this.textRows - 1)));
    } else if (matchesKey(data, "home") || matchesKey(data, "end")) {
      screen.scroll = matchesKey(data, "home") ? 0 : Math.max(0, this.allTextRows - this.textRows);
    } else if (data === "r") this.refresh();
    else screen.list?.handleInput(data);
    this.deps.render();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const screen = this.screen;
    if (!screen) return;
    if (event.type === "wheel" && event.y < this.listTop) {
      screen.scroll = Math.max(0, Math.min(Math.max(0, this.allTextRows - this.textRows), screen.scroll + (event.wheelDelta ?? 0)));
      this.deps.render(); return { handled: true };
    }
    if (event.y < this.listTop) return { handled: true, focus: true };
    const target = screen.input ?? screen.list;
    const result = target?.handleMouse?.({ ...event, x: event.x - 2, y: event.y - this.listTop });
    this.deps.render();
    return result;
  }
  render(width: number): string[] {
    const screen = this.screen;
    if (!screen) return [];
    const inner = Math.max(1, width - 4), height = Math.max(7, this.deps.rows());
    const text = new Text(clean(screen.text), 0, 0).render(inner);
    const message = this.message ? new Text(clean(this.message), 0, 0).render(inner).slice(0, 3) : [];
    const available = Math.max(1, height - 6 - message.length);
    this.textRows = screen.input ? Math.max(1, available - 2) : Math.min(Math.max(1, Math.floor(available / 2)), text.length);
    this.allTextRows = text.length;
    screen.scroll = Math.min(screen.scroll, Math.max(0, text.length - this.textRows));
    const listRows = Math.max(1, available - this.textRows);
    const count = Math.max(1, Math.floor((listRows - 1) / (screen.twoLine ? 3 : 1)));
    if (count !== this.visibleItems) {
      this.visibleItems = count;
      if (!screen.input) this.buildList(screen, screen.list?.getSelectedItem()?.value);
    }
    if (screen.input) screen.input.focused = this.focused;
    this.listTop = 2 + Math.min(this.textRows, text.length);
    const content = [truncateToWidth(`${this.focused ? "●" : "○"} 工作流 · ${line(screen.title)}`, inner, "…"),
      ...text.slice(screen.scroll, screen.scroll + this.textRows),
      ...(screen.input ? screen.input.render(inner) : screen.list?.render(inner) ?? []),
      ...message.map(row => `\x1b[33m${row}\x1b[0m`)];
    const body = content.slice(0, height - 4);
    while (body.length < height - 4) body.push("");
    body.push(dim(truncateToWidth("Tab 切换聊天 · Esc 返回一层", inner, "")), dim(truncateToWidth("↑↓ 选择 · Enter 确认 · PgUp/PgDn 读正文", inner, "")));
    const edge = dim("─".repeat(Math.max(0, width - 2)));
    return [dim("╭") + edge + dim("╮"), ...body.map(row => `${dim("│")} ${row}${" ".repeat(Math.max(0, inner - visibleWidth(row)))} ${dim("│")}`), dim("╰") + edge + dim("╯")];
  }
}
