/** 拥有者业务回答与工具审批分流；原始命令、回答与固定回执同事务登记。
 * Note: 见 .agents/notes/implemented/feature/2026-10-13-workflow-owner-input-and-delivery.md
 */
import type { Store } from "@ruukoto/core/store.ts";
import type { NotifyTarget } from "@ruukoto/core/types.ts";
import { sameTarget } from "@ruukoto/core/notify-target.ts";
import { sliceTextByBytes } from "@ruukoto/core/history.ts";
import { getWorkflowQuestion, listWorkflowRuns, listWorkflowSteps, workflowQuestionKey, WorkflowError, type WorkflowQuestion } from "@ruukoto/core/workflow.ts";
import type { ImControlInput, ImCommandOutcome } from "./im-approvals.ts";
import type { ImEntry } from "./im-entries.ts";
import type { SchedulerStore } from "./scheduler/store.ts";

type Command = { kind: "question"; runId: string; stepKey: string; offset: number } |
  { kind: "answer"; runId: string; stepKey: string; runVersion: number; version: number; answer: unknown } | { kind: "usage" };

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
  return /^\/(workflow-answer|workflow-question)(?:\s|$)/.test(raw) ? { kind: "usage" } : null;
}

export interface ImWorkflowsDeps {
  store: Store;
  sched: SchedulerStore;
  entry(source: string): Pick<ImEntry, "target" | "expectedActor" | "replyCapChars" | "externalIdPrefix"> | null;
  answer(input: { runId: string; stepKey: string; version: number; runVersion: number; requestKey: string; answer: unknown; txExtra: () => void }): WorkflowQuestion;
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

  handleCommand(input: ImControlInput): ImCommandOutcome | null {
    const command = parseImWorkflowCommand(input.commandText);
    if (!command) return null;
    const canonical = input.commandText.trim();
    const old = this.deps.store.findInboundEvent(input.source, input.externalId);
    if (old) {
      const consistent = old.eventKind === "im_workflow" && old.body === canonical && old.actor === input.actor &&
        (old.replyTarget === null || input.replyTarget === null ? old.replyTarget === input.replyTarget : sameTarget(old.replyTarget, input.replyTarget));
      return { control: true, eventId: old.id, outcome: consistent ? "redelivered_receipt_kept" : "request_conflict" };
    }
    const entry = this.deps.entry(input.source);
    const current = entry?.target();
    if (!input.replyTarget || !current || !input.actor || input.actor !== entry?.expectedActor() ||
        !sameTarget(current, input.replyTarget) || !input.externalId.startsWith(entry.externalIdPrefix(input.replyTarget))) {
      return this.receipt(input, canonical, "identity_failed", "拥有者入口已失效，业务回答未记录。", false);
    }
    if (command.kind === "usage") return this.receipt(input, canonical, "usage",
      "用法：/workflow-question <运行ID> <步骤键> [字节偏移]｜/workflow-answer <运行ID> <步骤键> <问题运行代次> <问题版本> <JSON回答>");
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
    const page = sliceTextByBytes(text, offset, Math.max(100, (this.deps.entry(source)?.replyCapChars() ?? 4000) - 600));
    return `${page.text}\n（字节 ${page.offset}–${page.offset + Buffer.byteLength(page.text)} / ${page.totalBytes}；完整正文可按偏移继续读取）`;
  }
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
    const { event } = this.deps.store.registerInboundEvent({ source: input.source, externalId: input.externalId, actor: input.actor,
      targetRole: "main", body: canonical, replyTarget: input.replyTarget, eventKind: "im_workflow", terminal: "done" });
    if (send && input.replyTarget) this.deps.sched.insertOp({ sourceKind: "inbound_event", sourceKey: event.id, taskId: null,
      hostOpId: null, target: input.replyTarget, text: this.cap(input.source, text), sourceRefs: [] });
    this.deps.store.appendEvent({ type: "workflow.input", eventId: event.id, source: input.source, outcome });
    return event.id;
  }
}
