/** 拥有者业务回答与工具审批分流；原始命令、回答与固定回执同事务登记。
 * Note: 见 .agents/notes/implemented/feature/2026-10-13-workflow-owner-input-and-delivery.md
 */
import type { Store } from "@ruukoto/core/store.ts";
import type { InboundEvent, NotifyTarget } from "@ruukoto/core/types.ts";
import { sameTarget } from "@ruukoto/core/notify-target.ts";
import { sliceTextByBytes } from "@ruukoto/core/history.ts";
import { getWorkflowQuestion, getWorkflowRun, listWorkflowRuns, listWorkflowSteps, parseWorkflowControl, workflowQuestionKey, WorkflowError, type WorkflowControl, type WorkflowQuestion } from "@ruukoto/core/workflow.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { ImControlInput, ImCommandOutcome } from "./im-approvals.ts";
import type { ImEntry } from "./im-entries.ts";
import type { SchedulerStore } from "./scheduler/store.ts";

type Command = { kind: "question"; runId: string; stepKey: string; offset: number } |
  { kind: "answer"; runId: string; stepKey: string; runVersion: number; version: number; answer: unknown } |
  { kind: "definitions"; offset: number } | { kind: "list"; offset: number } | { kind: "definition"; name: string; offset: number } |
  { kind: "run"; name: string; input: unknown } | { kind: "show"; runId: string; offset: number } | { kind: "logs"; runId: string; offset: number } |
  { kind: "step"; runId: string; stepKey: string; offset: number } |
  { kind: "control"; runId: string; version: number; control: WorkflowControl } | { kind: "usage" };

export function parseImWorkflowCommand(text: string): Command | null {
  const raw = text.trim();
  const detail = /^\/workflow-question\s+(\S+)\s+(\S+)(?:\s+(\d+))?$/.exec(raw);
  if (detail) {
    const offset = Number(detail[3] ?? 0);
    return Number.isSafeInteger(offset) && offset <= 1_000_000 ? { kind: "question", runId: detail[1], stepKey: detail[2], offset } : { kind: "usage" };
  }
  const answer = /^\/workflow-answer\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+([\s\S]+)$/.exec(raw);
  if (answer) {
    const runVersion = Number(answer[3]), version = Number(answer[4]);
    if (!Number.isSafeInteger(runVersion) || runVersion < 1 || !Number.isSafeInteger(version) || version < 1) return { kind: "usage" };
    let value: unknown;
    try { value = JSON.parse(answer[5]); }
    catch { return { kind: "usage" }; }
    return { kind: "answer", runId: answer[1], stepKey: answer[2], runVersion, version, answer: value };
  }
  const list = /^\/workflow-(definitions|list)(?:\s+(\d+))?$/.exec(raw);
  if (list) {
    const offset = Number(list[2] ?? 0);
    return Number.isSafeInteger(offset) ? { kind: list[1] === "list" ? "list" : "definitions", offset } : { kind: "usage" };
  }
  const view = /^\/workflow-(definition|show|logs)\s+(\S+)(?:\s+(\d+))?$/.exec(raw);
  if (view) {
    const offset = Number(view[3] ?? 0);
    if (!Number.isSafeInteger(offset)) return { kind: "usage" };
    return view[1] === "definition" ? { kind: "definition", name: view[2], offset } : { kind: view[1] === "show" ? "show" : "logs", runId: view[2], offset };
  }
  const step = /^\/workflow-step\s+(\S+)\s+(\S+)(?:\s+(\d+))?$/.exec(raw);
  if (step) {
    const offset = Number(step[3] ?? 0);
    return Number.isSafeInteger(offset) ? { kind: "step", runId: step[1], stepKey: step[2], offset } : { kind: "usage" };
  }
  const run = /^\/workflow-run\s+(\S+)\s+([\s\S]+)$/.exec(raw);
  if (run) {
    let input: unknown;
    try { input = JSON.parse(run[2]); }
    catch { return { kind: "usage" }; }
    return { kind: "run", name: run[1], input };
  }
  const control = /^\/workflow-(pause|resume|cancel|budget)\s+(\S+)\s+(\d+)(?:\s+([\s\S]+))?$/.exec(raw);
  if (control) {
    const version = Number(control[3]);
    if (!Number.isSafeInteger(version) || version < 1) return { kind: "usage" };
    let extra: unknown = {};
    if (control[4]) {
      try { extra = JSON.parse(control[4]); }
      catch { return { kind: "usage" }; }
    }
    if (typeof extra !== "object" || extra === null || Array.isArray(extra) || "action" in extra) return { kind: "usage" };
    let parsed: WorkflowControl;
    try { parsed = parseWorkflowControl({ ...extra, action: control[1] }); }
    catch { return { kind: "usage" }; }
    return { kind: "control", runId: control[2], version, control: parsed };
  }
  return /^\/workflow(?:-[a-z]+)?(?:\s|$)/.test(raw) ? { kind: "usage" } : null;
}

export interface ImWorkflowsDeps {
  store: Store;
  sched: SchedulerStore;
  entry(source: string): Pick<ImEntry, "target" | "expectedActor" | "replyCapChars" | "externalIdPrefix"> | null;
  answer(input: { runId: string; stepKey: string; version: number; runVersion: number; requestKey: string; answer: unknown; txExtra: () => void }): WorkflowQuestion;
  start(input: { name: string; input: unknown; requestKey: string }, origin: NonNullable<Parameters<Runtime["startWorkflowOwner"]>[1]>): ReturnType<Runtime["startWorkflowOwner"]>;
  control: Runtime["controlWorkflow"];
  detail: Runtime["getWorkflowDetail"];
  logs: Runtime["getWorkflowLogs"];
  step: Runtime["getWorkflowStep"];
  definitions: Runtime["workflowLibrary"]["list"];
  definition: Runtime["getWorkflowDefinition"];
  kickSender(): void;
}

export class ImWorkflows {
  constructor(private readonly deps: ImWorkflowsDeps) {}

  /** 通知不改变待答状态；恢复沿原键补记，已答/取消的通知由发送前检查拒绝。 */
  sweep(): void {
    for (const run of listWorkflowRuns(this.deps.store)) {
      if (!["running", "waiting"].includes(run.status) || !run.source.replyTarget) continue;
      for (const step of listWorkflowSteps(this.deps.store, run.id)) {
        const question = getWorkflowQuestion(this.deps.store, run.id, step.key);
        if (!question || question.status !== "pending") continue;
        const sourceKey = workflowQuestionKey(question);
        if (this.deps.sched.findOpBySource("workflow_question", sourceKey)) continue;
        const target = question.source.replyTarget!;
        const text = `【工作流需要回答】${run.id} / ${step.key}\n${this.preview(JSON.stringify(question.prompt), target.channel, 0)}\n详情：/workflow-question ${run.id} ${step.key}\n回答（JSON）：/workflow-answer ${run.id} ${step.key} ${question.runVersion} ${question.version} <JSON>\n这是业务回答，工具批准仍使用 /approve。`;
        this.deps.store.withTx(() => this.deps.sched.insertOp({ sourceKind: "workflow_question", sourceKey, taskId: run.source.taskId,
          hostOpId: null, target, text: this.cap(target.channel, text), sourceRefs: [] }));
      }
    }
    this.deps.kickSender();
  }

  async handleCommand(input: ImControlInput): Promise<ImCommandOutcome | null> {
    const command = parseImWorkflowCommand(input.commandText);
    if (!command) return null;
    const canonical = input.commandText.trim();
    const old = this.deps.store.findInboundEvent(input.source, input.externalId);
    if (old) {
      const consistent = this.sameCommand(old, input, canonical);
      return { control: true, eventId: old.id, outcome: consistent ? "redelivered_receipt_kept" : "request_conflict" };
    }
    const entry = this.deps.entry(input.source);
    const current = entry?.target();
    if (!input.replyTarget || !current || !input.actor || input.actor !== entry?.expectedActor() ||
        !sameTarget(current, input.replyTarget) || !input.externalId.startsWith(entry.externalIdPrefix(input.replyTarget))) {
      return this.receipt(input, canonical, "identity_failed", "拥有者入口已失效，业务回答未记录。", false);
    }
    if (command.kind === "usage") return this.receipt(input, canonical, "usage",
      "工作流命令：/workflow-definitions｜/workflow-definition <名称> [字节偏移]｜/workflow-run <名称> <JSON参数>｜/workflow-list [列表偏移]｜/workflow-show <完整运行ID> [字节偏移]｜/workflow-logs <运行ID> [字节偏移]｜/workflow-step <运行ID> <步骤键> [字节偏移]｜/workflow-question <运行ID> <步骤键>｜/workflow-answer <运行ID> <步骤键> <问题运行代次> <问题版本> <JSON回答>｜/workflow-pause、resume、cancel <运行ID> <当前版本>；resume 可加 {\"clockConfirmed\":true,\"stopsConfirmed\":true}；/workflow-budget <运行ID> <当前版本> {\"maxAttempts\":100,\"durationMs\":3600000}。请先 /workflow-show 核实，业务回答不批准工具。");
    if (command.kind !== "question" && command.kind !== "answer") {
      let eventId: string | null = null;
      try {
        if (command.kind === "definitions") return this.receipt(input, canonical, "definitions", JSON.stringify(await this.deps.definitions(command.offset, 10)));
        if (command.kind === "definition") {
          const definition = await this.deps.definition({ name: command.name, offset: command.offset, length: this.pageBytes(input.source) });
          return this.receipt(input, canonical, "definition", `定义 ${command.name} ${definition.id} ${definition.digest}\n${definition.text}\n（字节 ${definition.offset}–${definition.offset + Buffer.byteLength(definition.text)} / ${definition.totalBytes}）`);
        }
        if (command.kind === "run") {
          await this.deps.start({ name: command.name, input: command.input, requestKey: `im:${input.source}:${input.externalId}` }, {
            sourceEvent: () => this.register(input, canonical),
            txExtra: run => { eventId = this.persist(input, canonical, "started", `已启动工作流 ${run.id}；/workflow-show ${run.id} 查看状态，聊天可继续。`); },
          });
          this.deps.kickSender();
          return { control: true, eventId, outcome: "started" };
        }
        if (command.kind === "list") {
          const runs = listWorkflowRuns(this.deps.store).filter(run => run.source.replyTarget && sameTarget(run.source.replyTarget, input.replyTarget!)).reverse();
          const page = runs.slice(command.offset, command.offset + 10).map(run => `${run.id} ${run.status} v${run.version} ${run.reason ?? ""}`);
          return this.receipt(input, canonical, "list", `${page.join("\n") || "本入口没有工作流"}\n共 ${runs.length} 项；下一列表偏移 ${command.offset + page.length}`);
        }
        const run = getWorkflowRun(this.deps.store, command.runId);
        if (!run?.source.replyTarget || !sameTarget(run.source.replyTarget, input.replyTarget)) return this.receipt(input, canonical, "not_found", "运行不存在或不属于本入口；请用 /workflow-list 查看完整运行 ID。", true);
        if (command.kind === "show") return this.receipt(input, canonical, "show", `运行 ${run.id} ${run.status} v${run.version}\n${this.preview(JSON.stringify(this.deps.detail(run.id)), input.source, command.offset)}`);
        if (command.kind === "logs" || command.kind === "step") {
          const page = command.kind === "logs" ? this.deps.logs(run.id, command.offset, this.pageBytes(input.source)) : this.deps.step(run.id, command.stepKey, command.offset, this.pageBytes(input.source));
          return this.receipt(input, canonical, command.kind, `${page.text}\n（字节 ${page.offset}–${page.offset + Buffer.byteLength(page.text)} / ${page.totalBytes}）`);
        }
        await this.deps.control({ runId: run.id, requestKey: `im:${input.source}:${input.externalId}`, version: command.version, control: command.control,
          txExtra: () => { eventId = this.persist(input, canonical, command.control.action, `已提交 ${command.control.action} 请求；/workflow-show ${run.id} 核实状态和停止事实，成果保留。`); } });
        this.deps.kickSender();
        return { control: true, eventId, outcome: command.control.action };
      } catch (error) {
        if (eventId !== null && this.deps.store.getInboundEvent(eventId)) {
          process.stderr.write("[ruukoto:workflow] IM 控制意图已提交，停止收尾失败；请查询运行并核实执行\n");
          this.deps.kickSender();
          return { control: true, eventId, outcome: "control_committed" };
        }
        if (!(error instanceof WorkflowError) && !(error instanceof RuntimeApiError)) throw error;
        const raced = this.deps.store.findInboundEvent(input.source, input.externalId);
        if (error.code === "request_conflict" && raced) return { control: true, eventId: raced.id, outcome: "request_conflict" };
        return this.receipt(input, canonical, error.code, `工作流请求被拒绝（${error.code}）；定义用 /workflow-definition 核实文件，运行用 /workflow-list、/workflow-show 查看当前版本和等待原因；未自动重试。`);
      }
    }
    const question = getWorkflowQuestion(this.deps.store, command.runId, command.stepKey);
    if (!question || !this.belongs(question, input.replyTarget)) return this.receipt(input, canonical, "not_found", "问题不存在或不属于本入口，未记录回答。", true);
    if (command.kind === "question") return this.receipt(input, canonical, "question",
      `问题 ${question.runId} / ${question.stepKey}｜${question.status}｜运行代次 ${question.runVersion}，问题版本 ${question.version}\n${this.preview(JSON.stringify({ prompt: question.prompt, answer: question.answer }), input.source, command.offset)}`);
    let eventId: string | null = null;
    try {
      this.deps.answer({ ...command, requestKey: `im:${input.source}:${input.externalId}`, txExtra: () => {
        eventId = this.persist(input, canonical, "answered", "业务回答已记录；工具审批未改变。");
      } });
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      return this.receipt(input, canonical, error.code, `回答未记录（${error.code}）；请查看问题的状态、约束和版本后再答。`);
    }
    this.deps.kickSender();
    return { control: true, eventId, outcome: "answered" };
  }

  private belongs(question: WorkflowQuestion, target: NotifyTarget): boolean {
    return question.source.replyTarget !== null && sameTarget(question.source.replyTarget, target);
  }
  private preview(text: string, source: string, offset: number): string {
    const page = sliceTextByBytes(text, offset, this.pageBytes(source));
    return `${page.text}\n（字节 ${page.offset}–${page.offset + Buffer.byteLength(page.text)} / ${page.totalBytes}；完整正文可按偏移继续读取）`;
  }
  private pageBytes(source: string): number { return Math.max(100, (this.deps.entry(source)?.replyCapChars() ?? 4000) - 600); }
  private cap(source: string, text: string): string {
    const cap = this.deps.entry(source)?.replyCapChars() ?? 4000;
    return [...text].length <= cap ? text : `${[...text].slice(0, cap - 1).join("")}…`;
  }
  private receipt(input: ImControlInput, canonical: string, outcome: string, text: string, send = true): ImCommandOutcome {
    const eventId = this.deps.store.withTx(() => this.persist(input, canonical, outcome, text, send));
    this.deps.kickSender();
    return { control: true, eventId, outcome };
  }
  private persist(input: ImControlInput, canonical: string, outcome: string, text: string, send = true): string {
    const eventId = this.register(input, canonical);
    if (this.deps.sched.findOpBySource("inbound_event", eventId)) return eventId;
    if (send && input.replyTarget) this.deps.sched.insertOp({ sourceKind: "inbound_event", sourceKey: eventId, taskId: null,
      hostOpId: null, target: input.replyTarget, text: this.cap(input.source, text), sourceRefs: [] });
    this.deps.store.appendEvent({ type: "workflow.input", eventId, source: input.source, outcome });
    return eventId;
  }
  private register(input: ImControlInput, canonical: string): string {
    const old = this.deps.store.findInboundEvent(input.source, input.externalId);
    if (old && !this.sameCommand(old, input, canonical)) throw new WorkflowError("request_conflict");
    return this.deps.store.registerInboundEvent({ source: input.source, externalId: input.externalId, actor: input.actor,
      targetRole: "main", body: canonical, replyTarget: input.replyTarget, eventKind: "im_workflow", terminal: "done" }).event.id;
  }
  private sameCommand(old: InboundEvent, input: ImControlInput, canonical: string): boolean {
    return old.eventKind === "im_workflow" && old.body === canonical && old.actor === input.actor &&
      (old.replyTarget === null || input.replyTarget === null ? old.replyTarget === input.replyTarget : sameTarget(old.replyTarget, input.replyTarget));
  }
}
