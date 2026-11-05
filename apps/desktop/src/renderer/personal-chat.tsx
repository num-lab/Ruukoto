import { useEffect, useRef, useState } from "react";
import { ToggleGroup } from "radix-ui";
import { ArrowUp, Loader2, Paperclip, Sparkles } from "lucide-react";
import type { PersonalDesktopActionName, PersonalDesktopApproval, PersonalDesktopQuestion } from "@ruukoto/view/personal-protocol.ts";
import { personalCardKey, type PersonalPresentedMessage, type PersonalState } from "./personal-state.ts";
import { MarkdownText } from "./markdown.tsx";
import { resizeComposerInput, submitOnEnter } from "./composer.tsx";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Bubble, BubbleContent } from "./components/ui/bubble.tsx";
import { Message, MessageContent } from "./components/ui/message.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemHeader, ItemTitle } from "./components/ui/item.tsx";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "./components/ui/message-scroller.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

function Text({ children }: { children: string }) { return <div className="markdown"><MarkdownText>{children}</MarkdownText></div>; }
function PersonalMessage({ model, message }: { model: PersonalState; message: PersonalPresentedMessage }) {
  const body = model.bodies.get(message.entry);
  const content = <><Text>{body ?? message.text}</Text>{message.pendingStatus && <p role="status">{message.pendingStatus === "queued" ? "等待处理" : "正在核实接纳"}</p>}{message.input?.status === "queued" && <p role="status">等待处理</p>}{message.input?.status === "unanswered" && <p role="status">未完成处理</p>}{message.truncated && body === undefined && <Button type="button" size="sm" variant="ghost" disabled={!model.online || model.loadingBody.has(message.entry)} onClick={() => void model.body(message.entry)}>读取完整内容</Button>}</>;
  return <Message className="personal-message" align={message.role === "user" ? "end" : "start"}><MessageContent><Bubble variant="muted" align={message.role === "user" ? "end" : "start"}><BubbleContent>{content}</BubbleContent></Bubble></MessageContent></Message>;
}

type PersonalMessageGroup = { type: "messages"; role: "user" | "assistant"; messages: PersonalPresentedMessage[] };
type PersonalRow = PersonalMessageGroup | { type: "approval"; value: PersonalDesktopApproval } | { type: "question"; value: PersonalDesktopQuestion };
// Note: See .agents/notes/implemented/feature/2026-11-01-desktop-personal-message-bubbles.md
function personalMessageGroups(timeline: PersonalPresentedMessage[], cards: PersonalDesktopApproval[], questions: PersonalDesktopQuestion[]): PersonalRow[] {
  const groups: PersonalRow[] = [];
  const rows = [...timeline.map(entry => ({ anchor: entry.entry, type: "message" as const, entry })), ...cards.map(value => ({ anchor: value.occurrence, type: "approval" as const, value })), ...questions.map(value => ({ anchor: value.occurrence, type: "question" as const, value }))].sort((a, b) => a.anchor - b.anchor);
  for (const row of rows) {
    if (row.type === "approval") { groups.push({ type: "approval", value: row.value }); continue; }
    if (row.type === "question") { groups.push({ type: "question", value: row.value }); continue; }
    const entry = row.entry;
    if (entry.partial || entry.role !== "user" && entry.role !== "assistant" || !entry.text.trim() && !entry.truncated) continue;
    const previous = groups.at(-1);
    if (previous?.type === "messages" && previous.role === entry.role) previous.messages.push(entry);
    else groups.push({ type: "messages", role: entry.role, messages: [entry] });
  }
  return groups;
}

function approvalTitle(value: PersonalDesktopApproval) { return ({ write_file: "修改文件", read_file: "读取文件", http_request: "网络请求", web_search: "搜索网络", list_files: "查看文件", search_files: "搜索文件", service_restart: "重启服务", service_inspect: "检查服务", app_data: "修改数据", run_command: "运行命令", browser: "网页操作", cua: "电脑操作", process: "后台进程" } as const)[value.kind]; }
function approvalStatus(value: PersonalDesktopApproval) {
  if (value.notice) return value.notice;
  if (value.code === "started") return "操作已开始，结果待核实";
  if (value.effect === "effect_unknown") return "操作结果未知，请核实原操作";
  if (value.started) return value.effect === "returned" || value.effect === "committed" ? value.stopped ? "操作已返回" : "操作已返回，停止待核实" : "操作未完成";
  if (value.approval === "rejected") return "已拒绝本次操作，未执行";
  if (value.observed && value.effect === "not_executed") return "本次操作未执行";
  if (value.approval === "approved") return "已批准，等待执行";
  return value.canDecide ? "" : "请在原入口处理";
}
function ApprovalCard({ model, value }: { model: PersonalState; value: PersonalDesktopApproval }) {
  const [confirmSandbox, setConfirmSandbox] = useState(false);
  const key = personalCardKey(value), family = value.family ?? "tools", detail = model.details.get(key), uncertain = family === "tools" && model.uncertainDecisions.has(value.operation), busy = family === "tools" && model.deciding.has(value.operation);
  useEffect(() => { if (model.online && !model.details.has(key)) void model.loadCard(value); }, [model, model.online, key, value.admission]);
  let content = detail?.text ?? "", parseError = false;
  let target = value.target + (value.targetTruncated ? "…" : ""), clearsFile = false;
  if (detail?.complete) {
    try {
      const original: unknown = JSON.parse(detail.text);
      if (!original || typeof original !== "object" || !("target" in original) || typeof original.target !== "string" || !("params" in original) || !original.params || typeof original.params !== "object" || Array.isArray(original.params) || original.target.slice(0, 512) !== value.target || (original.target.length > 512) !== value.targetTruncated || detail.admission !== value.admission || (detail.family ?? "tools") !== family) parseError = true;
      else {
        target = original.target;
        content = value.kind === "write_file" && "content" in original.params && typeof original.params.content === "string" ? original.params.content : JSON.stringify(original.params, null, 2);
        clearsFile = value.kind === "write_file" && content === "";
      }
    }
    catch { parseError = true; }
  }
  const actionUncertain = model.uncertainActions.get(key);
  const disabled = !model.online || busy || uncertain || model.actionBlocked(family, value.operation) || model.refreshingCards.has(key) || !detail?.complete || parseError;
  const labels: Partial<Record<PersonalDesktopActionName, string>> = { check: "检查原操作", cleanup: "停止原执行", claim_applied: "确认已生效", claim_not_applied: "确认未生效", end_unknown: "结束此工作，保留未知结果", resume: "继续此工作", observe: "查看新现场", accept: "接受新现场", stop_sandbox: "停止整个原沙箱" };
  return <MessageScrollerItem messageId={`approval:${value.occurrence}`}><Item asChild variant="muted" size="sm"><section aria-label={approvalTitle(value)}>
    <ItemHeader className="flex-wrap"><ItemTitle>{approvalTitle(value)}</ItemTitle>{value.canDecide && <ItemActions><Button variant="ghost" size="sm" disabled={disabled} onClick={() => void model.decideCard(value, "rejected")}>拒绝本次</Button><Button size="sm" disabled={disabled} aria-busy={busy} onClick={() => void model.decideCard(value, "approved")}>批准本次</Button></ItemActions>}</ItemHeader>
    <ItemContent className="min-w-0 basis-full gap-2"><ItemDescription className="line-clamp-none break-all">{target}</ItemDescription>{clearsFile ? <p>文件内容将清空</p> : content && <pre tabIndex={0} className="command-code command-preview selectable-text whitespace-pre-wrap break-words">{content}</pre>}{approvalStatus(value) && <p role="status">{approvalStatus(value)}</p>}
      {value.check && <p>{value.check.kind === "receipt" ? "原操作回执" : "当前观察"}：{value.check.text}</p>}
      {value.claim && <p>你的记录：{value.claim.effect === "applied" ? "已生效" : "未生效"} · {new Date(value.claim.at).toLocaleString("zh-CN")}</p>}
      {value.observation !== undefined && model.cuaImages.get(value.operation)?.observation === value.observation && model.cuaImages.get(value.operation)!.images.map((image, index) => <img key={`${value.observation}:${image.id}`} src={image.src} alt={`新现场截图 ${index + 1}`} style={{ maxWidth: "100%", height: "auto" }} onLoad={() => model.cuaImageLoaded(value, image.id, true)} onError={() => model.cuaImageLoaded(value, image.id, false)} />)}
      {!!value.images?.length && value.observation && !model.cuaImages.has(value.operation) && <Button variant="ghost" size="sm" disabled={!model.online || model.cuaImageLoading.has(value.operation)} onClick={() => void model.loadCuaImages(value)}>查看新截图</Button>}
      {!!value.actions?.some(action => labels[action]) && <ItemActions className="flex-wrap">{value.actions.filter(action => labels[action]).map(action => <Button key={action} variant="ghost" size="sm" disabled={disabled || action === "accept" && !model.canAcceptCua(value)} onClick={() => action === "stop_sandbox" ? setConfirmSandbox(true) : void model.cardAction(value, action)}>{labels[action]}</Button>)}</ItemActions>}
      {confirmSandbox && value.actions?.includes("stop_sandbox") && <div><p>停止整个原沙箱会丢失内存及未保存的应用状态，磁盘保留。</p><ItemActions><Button variant="ghost" size="sm" onClick={() => setConfirmSandbox(false)}>返回</Button><Button size="sm" disabled={disabled} onClick={() => { setConfirmSandbox(false); void model.cardAction(value, "stop_sandbox"); }}>确认停止整个原沙箱</Button></ItemActions></div>}
      {detail?.nextOffset !== undefined && <Button variant="ghost" size="sm" disabled={!model.online} onClick={() => void model.loadCard(value, true)}>继续读取</Button>}
      {(uncertain || model.refreshingCards.has(key) || detail?.error || parseError) && <p role="status">{uncertain || model.refreshingCards.has(key) ? "决定结果待核实" : detail?.error ?? "操作内容无法解析"}<Button variant="ghost" size="sm" disabled={!model.online || busy} onClick={() => void model.loadCard(value)}>核实原决定</Button></p>}
      {actionUncertain && <p role="status">选择结果待核实<Button variant="ghost" size="sm" disabled={!model.online} onClick={() => void model.inspectAction(actionUncertain)}>核实原选择</Button></p>}
    </ItemContent>
  </section></Item></MessageScrollerItem>;
}
function workStatus(value: PersonalState["works"][number]) {
  return value.cancelRequested && !value.stopVerified ? "已请求取消，停止待核实" : ({ pending: "等待执行", running: "执行中", waiting: "等待处理", completing: "正在收尾", completed: "已完成", failed: "未完成", aborted: "已取消", faulted: "异常停止", orphaned: "执行归属待核实" } as Record<string, string>)[value.state] ?? "状态待核实";
}
function WorkItem({ model, value, grouped = false }: { model: PersonalState; value: PersonalState["works"][number]; grouped?: boolean }) {
  return <Item variant={grouped ? "default" : "muted"} size={grouped ? "xs" : "sm"}><ItemContent><ItemTitle>{value.label}</ItemTitle><ItemDescription>{workStatus(value)}</ItemDescription>{value.progress && <p>要求：已接纳 {value.progress.accepted} 条 · 已读取 {value.progress.modelRead} 条 · 已回应 {value.progress.completed} 条</p>}</ItemContent><ItemActions><Button size="sm" variant="ghost" disabled={!model.online} onClick={() => void model.selectWork(value)}>查看状态</Button>{value.delegation === undefined && !["completed", "failed", "aborted", "faulted", "orphaned"].includes(value.state) && <Button size="sm" variant="ghost" disabled={!model.online || model.actionBusy || value.cancelRequested} onClick={() => void model.cancelWork(value)}>取消此工作</Button>}</ItemActions></Item>;
}
function delegationStatus(value: PersonalState["delegations"][number], hasMembers: boolean) {
  const state = value.report?.publication !== undefined ? "结果已发布" : ({ active: "工作进行中", idle: "工作空闲", reporting: value.active > 0 ? "工作进行中" : "正在准备结果", reported: "报告处理已结束", report_failed: "结果未完成，请查看原工作", canceling: "已请求取消，正在核实停止", canceled: "已取消，停止已核实", stop_unverified: "停止待核实", paused: "操作结果待核实" } as Record<string, string>)[value.state] ?? "状态待核实";
  return (hasMembers && ["active", "idle", "reporting"].includes(value.state) && value.active > 0 && value.report?.publication === undefined ? "" : state) + (value.report && ["failed", "effect_unknown"].includes(value.report.delivery) ? " · 送达结果待核实" : "");
}

function QuestionCard({ model, value }: { model: PersonalState; value: PersonalDesktopQuestion }) {
  const detail = model.questionDetails.get(value.id), draft = model.questionDraft(value), pending = value.status === "pending";
  const request = model.uncertainActions.get(`questions:${value.id}`), blocked = model.actionBlocked("questions", Number(value.id));
  useEffect(() => { if (model.online && detail?.version !== value.version) void model.loadQuestion(value); }, [model, model.online, value.id, value.version, detail?.version]);
  const item = detail?.questions[draft.index], answer = draft.answers[draft.index], many = (detail?.questions.length ?? 0) > 1, valid = !!answer?.text.trim();
  const disabled = blocked || !value.canAnswer || !detail || detail.version !== value.version;
  const labels = item?.options?.map(option => typeof option === "string" ? option : option.label) ?? [];
  const choices = item?.options?.map((option, index) => <ToggleGroup.Item key={index} value={String(index)} asChild><Button type="button" variant="ghost" className="owner-question-option"><span className="owner-question-option-copy"><span>{labels[index]}</span>{typeof option !== "string" && option.description && <span className="owner-question-option-description">{option.description}</span>}</span></Button></ToggleGroup.Item>);
  const textId = `personal-answer-${value.id}-${value.occurrence}`;
  return <MessageScrollerItem messageId={`question:${value.occurrence}`}><Item asChild variant="muted" size="sm"><section aria-label="工作问题">
    <ItemHeader><ItemTitle>{!pending ? ({ answered: "已回答", canceled: "已取消", stale: "已失效" } as Record<string, string>)[value.status] : draft.review ? "核对回答" : item?.question ?? value.question}</ItemTitle></ItemHeader>
    <ItemContent className="basis-full">
      {!detail || detail.version !== value.version ? <><p>{value.question}</p><Button variant="ghost" disabled={!model.online} onClick={() => void model.loadQuestion(value)}>读取原问题</Button></>
        : !pending || draft.review ? <FieldGroup>{detail.questions.map((question, index) => <Field key={index}><FieldLabel>{question.question}</FieldLabel><FieldDescription className="whitespace-pre-wrap">{(!pending ? detail.answer?.answers[index] : draft.answers[index])?.text || (!pending ? "" : "已跳过")}</FieldDescription></Field>)}</FieldGroup>
        : item && answer && <FieldGroup><Field><FieldLabel className="sr-only" htmlFor={textId}>{item.question}</FieldLabel>
          {item.options && (item.multiple ? <ToggleGroup.Root type="multiple" value={answer.options?.map(String) ?? []} onValueChange={values => model.chooseQuestion(value, values.map(Number))} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{choices}</ToggleGroup.Root> : <ToggleGroup.Root type="single" value={answer.option === undefined ? "" : String(answer.option)} onValueChange={selected => { if (selected !== "") model.chooseQuestion(value, Number(selected)); }} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{choices}</ToggleGroup.Root>)}
          <Textarea id={textId} value={answer.option === undefined && !answer.options ? answer.text : ""} disabled={disabled} maxLength={4096} rows={1} onChange={event => model.editQuestion(value, event.target.value)} placeholder={item.options ? "输入其他回答…" : "输入回答…"} />
        </Field></FieldGroup>}
      {pending && !value.canAnswer && <p>请回原入口回答此问题。</p>}
      {pending && <ItemActions className="flex-wrap">
        {value.canCancel && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => void model.answerCard(value, true)}>取消原问题</Button>}
        {value.canAnswer && detail?.version === value.version && (draft.review ? <><Button variant="ghost" size="sm" disabled={disabled} onClick={() => model.backQuestion(value)}>返回修改</Button><Button size="sm" disabled={disabled} onClick={() => void model.answerCard(value)}>提交回答</Button></>
          : <>{many && draft.index > 0 && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => model.backQuestion(value)}>上一题</Button>}<Button variant="ghost" size="sm" disabled={disabled} onClick={() => model.nextQuestion(value, true)}>跳过</Button>{(!item?.options || item.multiple || answer?.option === undefined) && <Button size="sm" disabled={disabled || !valid} onClick={() => model.nextQuestion(value)}>{item?.multiple ? "Done" : many ? draft.index + 1 === detail.questions.length ? "核对回答" : "下一题" : "提交回答"}</Button>}</>)}
      </ItemActions>}
      {request && <p role="status">回答结果待核实<Button variant="ghost" size="sm" disabled={!model.online} onClick={() => void model.inspectAction(request)}>核实原回答</Button></p>}
    </ItemContent>
  </section></Item></MessageScrollerItem>;
}

function QuestionDialog({ model }: { model: PersonalState }) {
  const [step, setStep] = useState(0), [review, setReview] = useState(false);
  const question = model.question;
  useEffect(() => { setStep(0); setReview(false); }, [question?.id, question?.version]);
  if (!question) return null;
  const item = question.questions[step], answer = model.answers[step], local = !question.origin.telegram, pending = question.status === "pending", disabled = !model.online || model.actionBusy || !local || !pending;
  const labels = item.options?.map(option => typeof option === "string" ? option : option.label) ?? [];
  const choose = (values: string[]) => {
    const indexes = values.map(Number).sort((a, b) => a - b);
    model.answers[step] = indexes.length ? { text: indexes.map(index => labels[index]).join("\n"), ...(item.multiple ? { options: indexes } : { option: indexes[0] }) } : { text: "" };
    model.refresh();
  };
  const next = (skip = false) => { if (skip) model.answers[step] = { text: "" }; if (step + 1 === question.questions.length) setReview(true); else setStep(step + 1); };
  const options = item.options?.map((option, index) => <ToggleGroup.Item key={index} value={String(index)} asChild><Button type="button" variant="ghost" className="owner-question-option"><span className="owner-question-option-copy"><span>{labels[index]}</span>{typeof option !== "string" && option.description && <span className="owner-question-option-description">{option.description}</span>}</span></Button></ToggleGroup.Item>);
  return <Dialog open onOpenChange={open => { if (!open && !model.actionBusy) { model.question = null; model.refresh(); } }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{review ? "核对回答" : item.question}</DialogTitle><DialogDescription>{local ? "" : "请回原 IM 回答；此处可查询或取消问题。"}</DialogDescription></DialogHeader>{review ? <FieldGroup>{question.questions.map((value, index) => <Field key={index}><FieldLabel>{value.question}</FieldLabel><FieldDescription>{model.answers[index].text || "已跳过"}</FieldDescription></Field>)}</FieldGroup> : <FieldGroup><Field><FieldLabel className="sr-only" htmlFor="personal-answer">{item.question}</FieldLabel>{item.options && (item.multiple ? <ToggleGroup.Root type="multiple" value={answer.options?.map(String) ?? []} onValueChange={choose} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{options}</ToggleGroup.Root> : <ToggleGroup.Root type="single" value={answer.option === undefined ? "" : String(answer.option)} onValueChange={value => choose(value ? [value] : [])} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{options}</ToggleGroup.Root>)}<Textarea id="personal-answer" value={answer.option === undefined && !answer.options ? answer.text : ""} disabled={disabled} maxLength={4096} onChange={event => { model.answers[step] = { text: event.target.value }; model.refresh(); }} placeholder={item.options ? "输入其他回答…" : "输入回答…"} /></Field></FieldGroup>}<DialogFooter>{pending && <Button variant="ghost" disabled={!model.online || model.actionBusy} onClick={() => void model.answerQuestion(true)}>取消原问题</Button>}{local && pending && (review ? <><Button variant="ghost" disabled={model.actionBusy} onClick={() => setReview(false)}>返回修改</Button><Button disabled={disabled} onClick={() => void model.answerQuestion()}>提交回答</Button></> : <><Button variant="ghost" disabled={disabled || step === 0} onClick={() => setStep(step - 1)}>上一题</Button><Button variant="ghost" disabled={disabled} onClick={() => next(true)}>跳过</Button><Button disabled={disabled || !answer.text.trim()} onClick={() => next()}>{step + 1 === question.questions.length ? "核对回答" : "下一题"}</Button></>)}</DialogFooter></DialogContent></Dialog>;
}

function Controls({ model }: { model: PersonalState }) {
  const approval = model.approval, work = model.work;
  return <>
    {!model.questionCards.size && model.questions.filter(question => question.status === "pending").map(question => <MessageScrollerItem key={`question:${question.id}`}><Button variant="outline" disabled={!model.online} onClick={() => void model.selectQuestion(question.id)}>{question.question}</Button></MessageScrollerItem>)}
    {!model.questionCards.size && model.next.questions !== undefined && <Button variant="ghost" onClick={() => void model.more("questions")}>更多问题</Button>}
    {model.approvals.filter(value => !model.projection && (value.canDecide || value.approval === "pending" || value.decision === "pending")).map(value => <MessageScrollerItem key={value.key}><Button variant="outline" disabled={!model.online} onClick={() => void model.selectApproval(value)}>{value.unit ?? value.tool ?? value.name ?? value.target ?? "操作审批"}{!value.canDecide && " · 原入口处理"}</Button></MessageScrollerItem>)}
    {(["tools", "mcp", "app-data", "services"] as const).filter(kind => model.next[kind] !== undefined).map(kind => <Button key={kind} variant="ghost" onClick={() => void model.more(kind)}>更多{kind === "tools" ? "工具" : kind === "mcp" ? "MCP" : kind === "app-data" ? "应用数据" : "服务"}操作</Button>)}
    {model.delegations.map(value => {
      const members = model.works.filter(work => work.delegation === value.ref.entryId), status = delegationStatus(value, members.length > 0), canCancel = !value.cancelRequested && (value.active > 0 || value.state === "reporting");
      return <MessageScrollerItem key={`delegation:${value.ref.entryId}`}><Item variant="muted" size="sm">{(status || canCancel) && <ItemHeader>{status && <ItemDescription>{status}</ItemDescription>}{canCancel && <ItemActions className="ml-auto"><Button size="sm" variant="ghost" disabled={!model.online || model.actionBusy} onClick={() => void model.cancelDelegation(value)}>取消整项工作</Button></ItemActions>}</ItemHeader>}<ItemContent className="basis-full">{members.length ? <ItemGroup>{members.map(work => <WorkItem key={work.ref.taskId} model={model} value={work} grouped />)}</ItemGroup> : <ItemTitle className="line-clamp-none">{value.content}</ItemTitle>}</ItemContent></Item></MessageScrollerItem>;
    })}
    {model.works.filter(value => value.delegation === undefined || !model.delegations.some(group => group.ref.entryId === value.delegation)).map(value => <MessageScrollerItem key={`work:${value.ref.taskId}`}><WorkItem model={model} value={value} /></MessageScrollerItem>)}
    {(["approvals", "works", "delegations", "questions"] as const).filter(kind => model.projectionNext[kind] !== undefined).map(kind => <Button key={kind} variant="ghost" disabled={!model.online} onClick={() => void model.moreProjection(kind)}>更多{kind === "approvals" ? "决定" : kind === "questions" ? "问题" : "工作"}</Button>)}
    {!model.projection && model.next.works !== undefined && <Button variant="ghost" onClick={() => void model.more("works")}>更多工作</Button>}
    <QuestionDialog model={model} />
    <Dialog open={!!approval} onOpenChange={open => { if (!open && !model.actionBusy) { model.approval = null; model.refresh(); } }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>核实原操作</DialogTitle><DialogDescription>{approval?.value.target ?? approval?.value.unit ?? approval?.value.tool ?? approval?.value.name}</DialogDescription></DialogHeader><p>{approval?.value.status}</p><pre className="command-code command-preview selectable-text whitespace-pre-wrap">{approval?.text}</pre>{approval?.nextOffset !== undefined && <Button variant="ghost" onClick={() => void model.selectApproval(approval.value, true)}>继续读取原记录</Button>}{approval && model.uncertainApprovals.has(approval.value.key) && <p role="status">决定结果待核实<Button variant="ghost" disabled={!model.online || model.actionBusy} onClick={() => void model.selectApproval(approval.value)}>核实原决定</Button></p>}<DialogFooter>{approval?.value.canDecide ? <><Button variant="outline" disabled={!model.online || model.actionBusy || !approval.complete || model.uncertainApprovals.has(approval.value.key)} onClick={() => void model.decide("rejected")}>拒绝本次</Button><Button disabled={!model.online || model.actionBusy || !approval.complete || model.uncertainApprovals.has(approval.value.key)} onClick={() => void model.decide("approved")}>批准本次</Button></> : <p>此处只读，请按原入口与实际状态处理。</p>}</DialogFooter></DialogContent></Dialog>
    <Dialog open={!!work} onOpenChange={open => { if (!open) { model.work = null; model.refresh(); } }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{work?.summary.label ?? "后台工作"}</DialogTitle><DialogDescription>{work && workStatus(work.summary)}</DialogDescription></DialogHeader>{work?.result.notice && <p>{work.result.notice}</p>}<Text>{work?.result.text ?? (work ? workStatus(work.summary) : "")}</Text>{work?.result.nextOffset !== undefined && <Button variant="ghost" onClick={() => void model.selectWork(work.summary, true)}>继续读取结果</Button>}</DialogContent></Dialog>
  </>;
}

export function PersonalChat({ model, onConnect }: { model: PersonalState; onConnect: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const visible = () => { if (document.visibilityState === "visible") model.visible(); }; model.visible(); document.addEventListener("visibilitychange", visible); return () => document.removeEventListener("visibilitychange", visible); }, [model]);
  useEffect(() => { resizeComposerInput(input.current, 24); }, [model.draft]);
  useEffect(() => {
    const resize = () => resizeComposerInput(input.current, 24);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  if (!model.identity) return <div className="empty-state"><div className="empty-symbol"><Sparkles /></div><h1>连接你的个人 Agent</h1><p>{model.status.error?.message ?? model.status.detail ?? "在设置中输入个人 Agent 地址并配对。"}</p><Button onClick={onConnect}>PA 远程连接</Button></div>;
  const groups = personalMessageGroups(model.timeline, [...model.cards.values()], [...model.questionCards.values()]);
  return <><MessageScrollerProvider autoScroll defaultScrollPosition="start"><MessageScroller className="conversation"><MessageScrollerViewport className="stream-scroll selectable-text" preserveScrollOnPrepend aria-label="个人会话消息" onScroll={event => { if (event.currentTarget.scrollTop < 40) void model.older(); }}><MessageScrollerContent className="agent-stream native-message-stream selectable-text">
    {model.historyMore && <MessageScrollerItem><Button variant="ghost" disabled={!model.online || model.loadingHistory} onClick={() => void model.older()}>加载更早消息</Button></MessageScrollerItem>}
    {groups.map(group => {
      if (group.type === "approval") return <ApprovalCard key={`approval:${group.value.occurrence}`} model={model} value={group.value} />;
      if (group.type === "question") return <QuestionCard key={`question:${group.value.occurrence}`} model={model} value={group.value} />;
      const first = group.messages[0], date = new Date(first.timestamp);
      return <MessageScrollerItem key={first.requestKey ?? first.entry} messageId={first.requestKey ?? String(first.entry)}><div className={`personal-message-group ${group.role}`}><time className="personal-message-time" dateTime={date.toISOString()}>{date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>{group.messages.map(message => <PersonalMessage key={message.requestKey ?? message.entry} model={model} message={message} />)}</div></MessageScrollerItem>;
    })}
    <Controls model={model} />
  </MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider>
  <div className="composer-wrap"><div className="composer-width">{model.presence && <div role="status" className="task-notice">{model.presence}</div>}{model.message && <div role="status" className="task-notice">{model.message}</div>}{!model.online && <div className="task-notice" role="status">{model.status.error?.message ?? model.status.detail ?? (model.identity.online ? "正在重新同步消息…" : "后台离线或正在维护。")}<Button variant="ghost" onClick={onConnect}>连接设置</Button></div>}{model.draftMismatch && <div className="task-notice" role="status">草稿属于原连接，已停止向新档案发送。<Button variant="ghost" onClick={() => model.discardDraft()}>放弃原草稿</Button></div>}{model.pending && <div className="task-notice" role="status">原输入{model.pendingResult?.kind === "missing" ? "尚未查到接纳记录" : "结果待核实"}。<Button variant="ghost" disabled={!model.online || model.checking} onClick={() => void model.reconcile()}>核实原输入</Button>{model.pendingResult?.kind === "missing" && <Button variant="outline" disabled={!model.online || model.checking} onClick={() => void model.reconcile(true)}>继续提交原输入</Button>}</div>}
    <form className="surface-composer composer personal-composer" onSubmit={event => { event.preventDefault(); void model.send(); }}><Textarea ref={input} aria-label="输入个人消息" rows={1} value={model.draft} readOnly={model.sending || model.draftMismatch} placeholder="描述你想做的事…" onChange={event => model.edit(event.target.value)} onKeyDown={event => submitOnEnter(event, model.canSend, () => void model.send())} /><div className="composer-actions"><div className="composer-left"><Button type="button" size="icon" variant="ghost" className="attachment-button" aria-label="添加附件" aria-description="PA 暂不支持附件" title="PA 暂不支持附件" disabled><Paperclip /></Button></div><div className="composer-right"><Button size="icon" className="send-button" type="submit" disabled={!model.canSend} aria-label="发送个人消息" aria-busy={model.sending}>{model.sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button></div></div></form>
  </div></div></>;
}
