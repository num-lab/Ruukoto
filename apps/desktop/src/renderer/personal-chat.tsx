import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ToggleGroup } from "radix-ui";
import { ArrowUp, File, Loader2, MessagesCircle, Plus, X } from "lucide-react";
import type { PersonalDesktopActionName, PersonalDesktopApproval, PersonalDesktopOutput, PersonalDesktopQuestion } from "@ruukoto/view/personal-protocol.ts";
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
function OutputFile({ model, value }: { model: PersonalState; value: PersonalDesktopOutput }) {
  const incomplete = value.partial || value.bytes > 8 * 1024 * 1024, status = model.outputStatus.get(`${value.publication}:${value.output}`);
  return <Item variant="outline" size="sm"><ItemContent><ItemTitle className="break-all">{value.name}</ItemTitle><ItemDescription>{incomplete ? "The file is incomplete or over 8 MiB; preview and download unavailable" : `${value.bytes < 1024 ? `${value.bytes} B` : value.bytes < 1024 * 1024 ? `${(value.bytes / 1024).toFixed(1)} KiB` : `${(value.bytes / (1024 * 1024)).toFixed(1)} MiB`}`}</ItemDescription>{status && <p role="status">{status}</p>}</ItemContent>{!incomplete && <ItemActions><Button variant="ghost" size="sm" disabled={!model.online || model.outputBusy} onClick={() => void model.output(value, "preview")}>Preview</Button><Button variant="ghost" size="sm" disabled={!model.online || model.outputBusy} onClick={() => void model.output(value, "save")}>Download</Button></ItemActions>}</Item>;
}
function PersonalMessage({ model, message }: { model: PersonalState; message: PersonalPresentedMessage }) {
  const [animate, setAnimate] = useState(false);
  useLayoutEffect(() => { if (!animate && model.takeMessageAnimation(message.displayKey ?? message.entry)) setAnimate(true); });
  const body = model.bodies.get(message.entry);
  const content = <><Text>{body ?? message.text}</Text>{message.attachments?.map(attachment => <div key={attachment.id} className="attachment-chip"><File /><span title={attachment.name}>{attachment.name}</span></div>)}{(message.pendingStatus === "unanswered" || message.input?.status === "unanswered") && <p role="status">Processing unfinished</p>}{message.truncated && body === undefined && <Button type="button" size="sm" variant="ghost" disabled={!model.online || model.loadingBody.has(message.entry)} onClick={() => void model.body(message.entry)}>Read full content</Button>}</>;
  return <Message className="personal-message" align={message.role === "user" ? "end" : "start"}><MessageContent><Bubble variant="muted" align={message.role === "user" ? "end" : "start"} data-animate={animate || undefined} aria-busy={message.pendingStatus === "checking"}>{message.pendingStatus === "checking" && <Loader2 className="personal-input-loading animate-spin" role="status" aria-label="Sending" />}<BubbleContent>{content}{message.outputs?.map(value => <OutputFile key={value.output} model={model} value={value} />)}</BubbleContent></Bubble></MessageContent></Message>;
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
    if (entry.partial || entry.role !== "user" && entry.role !== "assistant" || !entry.text.trim() && !entry.truncated && !entry.outputs?.length && !entry.attachments?.length) continue;
    const previous = groups.at(-1);
    if (previous?.type === "messages" && previous.role === entry.role) previous.messages.push(entry);
    else groups.push({ type: "messages", role: entry.role, messages: [entry] });
  }
  return groups;
}

function approvalTitle(value: PersonalDesktopApproval) { return ({ write_file: "Modify file", read_file: "Read file", http_request: "Network request", web_search: "Search the web", list_files: "List files", search_files: "Search files", service_restart: "Restart service", service_inspect: "Inspect service", app_data: "Modify data", run_command: "Run command", browser: "Web operation", cua: "Computer operation", process: "Background process" } as const)[value.kind]; }
function approvalStatus(value: PersonalDesktopApproval) {
  if (value.notice) return value.notice;
  if (value.code === "started") return "Operation started; outcome unverified";
  if (value.effect === "effect_unknown") return "Outcome unknown; verify the original operation";
  if (value.started) return value.effect === "returned" || value.effect === "committed" ? value.stopped ? "Operation returned" : "Operation returned; stop unverified" : "Operation unfinished";
  if (value.approval === "rejected") return "This operation was denied and not executed";
  if (value.observed && value.effect === "not_executed") return "This operation was not executed";
  if (value.approval === "approved") return "Approved; awaiting execution";
  return value.canDecide ? "" : "Handle it at the original entry";
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
  const labels: Partial<Record<PersonalDesktopActionName, string>> = { check: "Check the original operation", cleanup: "Stop the original execution", claim_applied: "Confirm applied", claim_not_applied: "Confirm not applied", end_unknown: "End this work; keep the unknown outcome", resume: "Continue this work", observe: "View the new state", accept: "Accept the new state", stop_sandbox: "Stop the entire original sandbox" };
  return <MessageScrollerItem messageId={`approval:${value.occurrence}`}><Item asChild variant="muted" size="sm"><section aria-label={approvalTitle(value)}>
    <ItemHeader className="flex-wrap"><ItemTitle>{approvalTitle(value)}</ItemTitle>{value.canDecide && <ItemActions><Button variant="ghost" size="sm" disabled={disabled} onClick={() => void model.decideCard(value, "rejected")}>Deny</Button><Button size="sm" disabled={disabled} aria-busy={busy} onClick={() => void model.decideCard(value, "approved")}>Approve</Button></ItemActions>}</ItemHeader>
    <ItemContent className="min-w-0 basis-full gap-2"><ItemDescription className="line-clamp-none break-all">{target}</ItemDescription>{clearsFile ? <p>The file contents will be cleared</p> : content && <pre tabIndex={0} className="command-code command-preview selectable-text whitespace-pre-wrap break-words">{content}</pre>}{approvalStatus(value) && <p role="status">{approvalStatus(value)}</p>}
      {value.check && <p>{value.check.kind === "receipt" ? "Original operation receipt" : "Current observation"}: {value.check.text}</p>}
      {value.claim && <p>Your record: {value.claim.effect === "applied" ? "applied" : "not applied"} · {new Date(value.claim.at).toLocaleString("en-US")}</p>}
      {value.observation !== undefined && model.cuaImages.get(value.operation)?.observation === value.observation && model.cuaImages.get(value.operation)!.images.map((image, index) => <img key={`${value.observation}:${image.id}`} src={image.src} alt={`New screenshot ${index + 1}`} style={{ maxWidth: "100%", height: "auto" }} onLoad={() => model.cuaImageLoaded(value, image.id, true)} onError={() => model.cuaImageLoaded(value, image.id, false)} />)}
      {!!value.images?.length && value.observation && !model.cuaImages.has(value.operation) && <Button variant="ghost" size="sm" disabled={!model.online || model.cuaImageLoading.has(value.operation)} onClick={() => void model.loadCuaImages(value)}>View new screenshots</Button>}
      {!!value.actions?.some(action => labels[action]) && <ItemActions className="flex-wrap">{value.actions.filter(action => labels[action]).map(action => <Button key={action} variant="ghost" size="sm" disabled={disabled || action === "accept" && !model.canAcceptCua(value)} onClick={() => action === "stop_sandbox" ? setConfirmSandbox(true) : void model.cardAction(value, action)}>{labels[action]}</Button>)}</ItemActions>}
      {confirmSandbox && value.actions?.includes("stop_sandbox") && <div><p>Stopping the entire original sandbox loses memory and unsaved app state; disk is kept.</p><ItemActions><Button variant="ghost" size="sm" onClick={() => setConfirmSandbox(false)}>Back</Button><Button size="sm" disabled={disabled} onClick={() => { setConfirmSandbox(false); void model.cardAction(value, "stop_sandbox"); }}>Confirm stopping the entire sandbox</Button></ItemActions></div>}
      {detail?.nextOffset !== undefined && <Button variant="ghost" size="sm" disabled={!model.online} onClick={() => void model.loadCard(value, true)}>Continue reading</Button>}
      {(uncertain || model.refreshingCards.has(key) || detail?.error || parseError) && <p role="status">{uncertain || model.refreshingCards.has(key) ? "Decision outcome unverified" : detail?.error ?? "Couldn't parse the operation content"}<Button variant="ghost" size="sm" disabled={!model.online || busy} onClick={() => void model.loadCard(value)}>Verify the original decision</Button></p>}
      {actionUncertain && <p role="status">Selection outcome unverified<Button variant="ghost" size="sm" disabled={!model.online} onClick={() => void model.inspectAction(actionUncertain)}>Verify the original selection</Button></p>}
    </ItemContent>
  </section></Item></MessageScrollerItem>;
}
function workStatus(value: PersonalState["works"][number]) {
  return value.cancelRequested && !value.stopVerified ? "Cancel requested; stop unverified" : ({ pending: "Pending", running: "Running", waiting: "Waiting", completing: "Finishing", completed: "Completed", failed: "Failed", aborted: "Canceled", faulted: "Stopped with errors", orphaned: "Ownership unverified" } as Record<string, string>)[value.state] ?? "Status unverified";
}
function WorkItem({ model, value, grouped = false }: { model: PersonalState; value: PersonalState["works"][number]; grouped?: boolean }) {
  return <Item variant={grouped ? "default" : "muted"} size={grouped ? "xs" : "sm"}><ItemContent><ItemTitle>{value.label}</ItemTitle><ItemDescription>{workStatus(value)}</ItemDescription>{value.progress && <p>Progress: {value.progress.accepted} accepted · {value.progress.modelRead} read · {value.progress.completed} answered</p>}</ItemContent><ItemActions><Button size="sm" variant="ghost" disabled={!model.online} onClick={() => void model.selectWork(value)}>View status</Button>{value.delegation === undefined && !["completed", "failed", "aborted", "faulted", "orphaned"].includes(value.state) && <Button size="sm" variant="ghost" disabled={!model.online || model.actionBusy || value.cancelRequested} onClick={() => void model.cancelWork(value)}>Cancel this work</Button>}</ItemActions></Item>;
}
function delegationStatus(value: PersonalState["delegations"][number], hasMembers: boolean) {
  const state = value.report?.publication !== undefined ? "Result published" : ({ active: "Work running", idle: "Work idle", reporting: value.active > 0 ? "Work running" : "Preparing result", reported: "Report handling ended", report_failed: "Result incomplete; check the original work", canceling: "Cancel requested; verifying the stop", canceled: "Canceled; stop verified", stop_unverified: "Stop unverified", paused: "Operation outcome unverified" } as Record<string, string>)[value.state] ?? "Status unverified";
  return (hasMembers && ["active", "idle", "reporting"].includes(value.state) && value.active > 0 && value.report?.publication === undefined ? "" : state) + (value.report && ["failed", "effect_unknown"].includes(value.report.delivery) ? " · Delivery outcome unverified" : "");
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
  return <MessageScrollerItem messageId={`question:${value.occurrence}`}><Item asChild variant="muted" size="sm"><section aria-label="Work question">
    <ItemHeader><ItemTitle>{!pending ? ({ answered: "Answered", canceled: "Canceled", stale: "Expired" } as Record<string, string>)[value.status] : draft.review ? "Review answers" : item?.question ?? value.question}</ItemTitle></ItemHeader>
    <ItemContent className="basis-full">
      {!detail || detail.version !== value.version ? <><p>{value.question}</p><Button variant="ghost" disabled={!model.online} onClick={() => void model.loadQuestion(value)}>Read the original question</Button></>
        : !pending || draft.review ? <FieldGroup>{detail.questions.map((question, index) => <Field key={index}><FieldLabel>{question.question}</FieldLabel><FieldDescription className="whitespace-pre-wrap">{(!pending ? detail.answer?.answers[index] : draft.answers[index])?.text || (!pending ? "" : "Skipped")}</FieldDescription></Field>)}</FieldGroup>
        : item && answer && <FieldGroup><Field><FieldLabel className="sr-only" htmlFor={textId}>{item.question}</FieldLabel>
          {item.options && (item.multiple ? <ToggleGroup.Root type="multiple" value={answer.options?.map(String) ?? []} onValueChange={values => model.chooseQuestion(value, values.map(Number))} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{choices}</ToggleGroup.Root> : <ToggleGroup.Root type="single" value={answer.option === undefined ? "" : String(answer.option)} onValueChange={selected => { if (selected !== "") model.chooseQuestion(value, Number(selected)); }} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{choices}</ToggleGroup.Root>)}
          <Textarea id={textId} value={answer.option === undefined && !answer.options ? answer.text : ""} disabled={disabled} maxLength={4096} rows={1} onChange={event => model.editQuestion(value, event.target.value)} placeholder={item.options ? "Type another answer…" : "Type your answer…"} />
        </Field></FieldGroup>}
      {pending && !value.canAnswer && <p>Answer this question at the original entry.</p>}
      {pending && <ItemActions className="flex-wrap">
        {value.canCancel && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => void model.answerCard(value, true)}>Cancel the original question</Button>}
        {value.canAnswer && detail?.version === value.version && (draft.review ? <><Button variant="ghost" size="sm" disabled={disabled} onClick={() => model.backQuestion(value)}>Back to edit</Button><Button size="sm" disabled={disabled} onClick={() => void model.answerCard(value)}>Submit answers</Button></>
          : <>{many && draft.index > 0 && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => model.backQuestion(value)}>Previous</Button>}<Button variant="ghost" size="sm" disabled={disabled} onClick={() => model.nextQuestion(value, true)}>Skip</Button>{(!item?.options || item.multiple || answer?.option === undefined) && <Button size="sm" disabled={disabled || !valid} onClick={() => model.nextQuestion(value)}>{item?.multiple ? "Done" : many ? draft.index + 1 === detail.questions.length ? "Review answers" : "Next" : "Submit answers"}</Button>}</>)}
      </ItemActions>}
      {request && <p role="status">Answer outcome unverified<Button variant="ghost" size="sm" disabled={!model.online} onClick={() => void model.inspectAction(request)}>Verify the original answer</Button></p>}
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
  return <Dialog open onOpenChange={open => { if (!open && !model.actionBusy) { model.question = null; model.refresh(); } }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{review ? "Review answers" : item.question}</DialogTitle><DialogDescription>{local ? "" : "Answer in the original IM; here you can read or cancel the question."}</DialogDescription></DialogHeader>{review ? <FieldGroup>{question.questions.map((value, index) => <Field key={index}><FieldLabel>{value.question}</FieldLabel><FieldDescription>{model.answers[index].text || "Skipped"}</FieldDescription></Field>)}</FieldGroup> : <FieldGroup><Field><FieldLabel className="sr-only" htmlFor="personal-answer">{item.question}</FieldLabel>{item.options && (item.multiple ? <ToggleGroup.Root type="multiple" value={answer.options?.map(String) ?? []} onValueChange={choose} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{options}</ToggleGroup.Root> : <ToggleGroup.Root type="single" value={answer.option === undefined ? "" : String(answer.option)} onValueChange={value => choose(value ? [value] : [])} disabled={disabled} className="flex flex-col gap-1" aria-label={item.question}>{options}</ToggleGroup.Root>)}<Textarea id="personal-answer" value={answer.option === undefined && !answer.options ? answer.text : ""} disabled={disabled} maxLength={4096} onChange={event => { model.answers[step] = { text: event.target.value }; model.refresh(); }} placeholder={item.options ? "Type another answer…" : "Type your answer…"} /></Field></FieldGroup>}<DialogFooter>{pending && <Button variant="ghost" disabled={!model.online || model.actionBusy} onClick={() => void model.answerQuestion(true)}>Cancel the original question</Button>}{local && pending && (review ? <><Button variant="ghost" disabled={model.actionBusy} onClick={() => setReview(false)}>Back to edit</Button><Button disabled={disabled} onClick={() => void model.answerQuestion()}>Submit answers</Button></> : <><Button variant="ghost" disabled={disabled || step === 0} onClick={() => setStep(step - 1)}>Previous</Button><Button variant="ghost" disabled={disabled} onClick={() => next(true)}>Skip</Button><Button disabled={disabled || !answer.text.trim()} onClick={() => next()}>{step + 1 === question.questions.length ? "Review answers" : "Next"}</Button></>)}</DialogFooter></DialogContent></Dialog>;
}

function Controls({ model }: { model: PersonalState }) {
  const approval = model.approval, work = model.work;
  return <>
    {!model.questionCards.size && model.questions.filter(question => question.status === "pending").map(question => <MessageScrollerItem key={`question:${question.id}`}><Button variant="outline" disabled={!model.online} onClick={() => void model.selectQuestion(question.id)}>{question.question}</Button></MessageScrollerItem>)}
    {!model.questionCards.size && model.next.questions !== undefined && <Button variant="ghost" onClick={() => void model.more("questions")}>More questions</Button>}
    {model.approvals.filter(value => !model.projection && (value.canDecide || value.approval === "pending" || value.decision === "pending")).map(value => <MessageScrollerItem key={value.key}><Button variant="outline" disabled={!model.online} onClick={() => void model.selectApproval(value)}>{value.unit ?? value.tool ?? value.name ?? value.target ?? "Operation approval"}{!value.canDecide && " · Original entry"}</Button></MessageScrollerItem>)}
    {(["tools", "mcp", "app-data", "services"] as const).filter(kind => model.next[kind] !== undefined).map(kind => <Button key={kind} variant="ghost" onClick={() => void model.more(kind)}>More {kind === "tools" ? "tool" : kind === "mcp" ? "MCP" : kind === "app-data" ? "app data" : "service"} actions</Button>)}
    {model.delegations.map(value => {
      const members = model.works.filter(work => work.delegation === value.ref.entryId), status = delegationStatus(value, members.length > 0), canCancel = !value.cancelRequested && (value.active > 0 || value.state === "reporting");
      return <MessageScrollerItem key={`delegation:${value.ref.entryId}`}><Item variant="muted" size="sm">{(status || canCancel) && <ItemHeader>{status && <ItemDescription>{status}</ItemDescription>}{canCancel && <ItemActions className="ml-auto"><Button size="sm" variant="ghost" disabled={!model.online || model.actionBusy} onClick={() => void model.cancelDelegation(value)}>Cancel the entire work</Button></ItemActions>}</ItemHeader>}<ItemContent className="basis-full">{members.length ? <ItemGroup>{members.map(work => <WorkItem key={work.ref.taskId} model={model} value={work} grouped />)}</ItemGroup> : <ItemTitle className="line-clamp-none">{value.content}</ItemTitle>}</ItemContent></Item></MessageScrollerItem>;
    })}
    {model.works.filter(value => value.delegation === undefined || !model.delegations.some(group => group.ref.entryId === value.delegation)).map(value => <MessageScrollerItem key={`work:${value.ref.taskId}`}><WorkItem model={model} value={value} /></MessageScrollerItem>)}
    {(["approvals", "works", "delegations", "questions"] as const).filter(kind => model.projectionNext[kind] !== undefined).map(kind => <Button key={kind} variant="ghost" disabled={!model.online} onClick={() => void model.moreProjection(kind)}>More {kind === "approvals" ? "decisions" : kind === "questions" ? "questions" : "work"}</Button>)}
    {!model.projection && model.next.works !== undefined && <Button variant="ghost" onClick={() => void model.more("works")}>More work</Button>}
    <QuestionDialog model={model} />
    <Dialog open={!!approval} onOpenChange={open => { if (!open && !model.actionBusy) { model.approval = null; model.refresh(); } }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Verify the original operation</DialogTitle><DialogDescription>{approval?.value.target ?? approval?.value.unit ?? approval?.value.tool ?? approval?.value.name}</DialogDescription></DialogHeader><p>{approval?.value.status}</p><pre className="command-code command-preview selectable-text whitespace-pre-wrap">{approval?.text}</pre>{approval?.nextOffset !== undefined && <Button variant="ghost" onClick={() => void model.selectApproval(approval.value, true)}>Continue reading the original record</Button>}{approval && model.uncertainApprovals.has(approval.value.key) && <p role="status">Decision outcome unverified<Button variant="ghost" disabled={!model.online || model.actionBusy} onClick={() => void model.selectApproval(approval.value)}>Verify the original decision</Button></p>}<DialogFooter>{approval?.value.canDecide ? <><Button variant="outline" disabled={!model.online || model.actionBusy || !approval.complete || model.uncertainApprovals.has(approval.value.key)} onClick={() => void model.decide("rejected")}>Deny</Button><Button disabled={!model.online || model.actionBusy || !approval.complete || model.uncertainApprovals.has(approval.value.key)} onClick={() => void model.decide("approved")}>Approve</Button></> : <p>Read-only here; act at the original entry based on the actual state.</p>}</DialogFooter></DialogContent></Dialog>
    <Dialog open={!!work} onOpenChange={open => { if (!open) { model.work = null; model.refresh(); } }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{work?.summary.label ?? "Background work"}</DialogTitle><DialogDescription>{work && workStatus(work.summary)}</DialogDescription></DialogHeader>{work?.result.notice && <p>{work.result.notice}</p>}<Text>{work?.result.text ?? (work ? workStatus(work.summary) : "")}</Text>{work?.result.nextOffset !== undefined && <Button variant="ghost" onClick={() => void model.selectWork(work.summary, true)}>Continue reading the result</Button>}</DialogContent></Dialog>
  </>;
}

export function PersonalChat({ model, onConnect }: { model: PersonalState; onConnect: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(model.attachments.length > 0);
  useEffect(() => { const visible = () => { if (document.visibilityState === "visible") model.visible(); else model.hidden(); }; visible(); document.addEventListener("visibilitychange", visible); return () => { document.removeEventListener("visibilitychange", visible); model.hidden(); }; }, [model]);
  useLayoutEffect(() => {
    const textarea = input.current, form = textarea?.form;
    if (!textarea || !form) return;
    const resize = () => {
      // Measure at the compact width so expansion cannot oscillate as the input gets wider.
      form.classList.remove("is-expanded");
      resizeComposerInput(textarea, 24);
      const next = model.attachments.length > 0 || textarea.scrollHeight > 24;
      form.classList.toggle("is-expanded", next);
      resizeComposerInput(textarea, 24);
      setExpanded(next);
    };
    resize();
    let width = form.clientWidth, frame = 0;
    const observer = new ResizeObserver(() => { if (form.clientWidth !== width) { width = form.clientWidth; cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); } });
    observer.observe(form);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", resize); };
  }, [model, model.draft, model.attachments.length, model.identity]);
  if (!model.identity) return <div className="empty-state"><div className="empty-symbol"><MessagesCircle /></div><h1>Connect your Personal Agent</h1><p>{model.status.error?.message ?? model.status.detail ?? "Enter your Personal Agent address in settings and pair."}</p><Button onClick={onConnect}>Personal connection</Button></div>;
  const groups = personalMessageGroups(model.timeline, [...model.cards.values()], [...model.questionCards.values()]);
  return <><MessageScrollerProvider autoScroll defaultScrollPosition="start"><MessageScroller className="conversation"><MessageScrollerViewport className="stream-scroll selectable-text" preserveScrollOnPrepend aria-label="Personal chat messages" onScroll={event => { if (event.currentTarget.scrollTop < 40) void model.older(); }}><MessageScrollerContent className="agent-stream native-message-stream selectable-text">
    {model.historyMore && <MessageScrollerItem><Button variant="ghost" disabled={!model.online || model.loadingHistory} onClick={() => void model.older()}>Load earlier messages</Button></MessageScrollerItem>}
    {groups.map(group => {
      if (group.type === "approval") return <ApprovalCard key={`approval:${group.value.occurrence}`} model={model} value={group.value} />;
      if (group.type === "question") return <QuestionCard key={`question:${group.value.occurrence}`} model={model} value={group.value} />;
      const first = group.messages[0], date = new Date(first.timestamp);
      return <MessageScrollerItem key={first.displayKey ?? first.entry} messageId={String(first.displayKey ?? first.entry)}><div className={`personal-message-group ${group.role}`}><time className="personal-message-time" dateTime={date.toISOString()}>{date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>{group.messages.map(message => <PersonalMessage key={message.displayKey ?? message.entry} model={model} message={message} />)}</div></MessageScrollerItem>;
    })}
    <Controls model={model} />
  </MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider>
  <div className="composer-wrap personal-composer-wrap"><div className="composer-width">{model.message && <div role="status" className="task-notice">{model.message}</div>}{!model.online && <div className="task-notice" role="status">{model.status.error?.message ?? model.status.detail ?? (model.identity.online ? "Resyncing messages…" : "The backend is offline or under maintenance.")}<Button variant="ghost" onClick={onConnect}>Connection settings</Button></div>}{model.draftMismatch && <div className="task-notice" role="status">The draft belongs to the original connection; sending to the new archive has stopped.<Button variant="ghost" onClick={() => model.discardDraft()}>Discard the original draft</Button></div>}{model.pending && model.pendingResult?.kind === "missing" && <div className="task-notice"><Button variant="ghost" disabled={!model.online || model.checking} onClick={() => void model.reconcile()}>Verify the original input</Button><Button variant="outline" disabled={!model.online || model.checking} onClick={() => void model.reconcile(true)}>Continue submitting the original input</Button></div>}
    <form className={`surface-composer composer personal-composer${expanded ? " is-expanded" : ""}`} onSubmit={event => { event.preventDefault(); void model.send(); }}>{model.attachments.length > 0 && <div className="attached-files" aria-label="Attached files">{model.attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><File /><span title={attachment.name}>{attachment.name}</span><button type="button" disabled={model.sending || model.attaching || !!model.pending || model.draftMismatch} aria-label={`Remove attachment ${attachment.name}`} onClick={() => void model.removeAttachment(attachment.id)}><X /></button></span>)}</div>}<Button type="button" size="icon" variant="ghost" className="personal-attach" aria-label="Add attachment" disabled={!model.canAttach} aria-busy={model.attaching} onClick={() => void model.attach()}>{model.attaching ? <Loader2 className="animate-spin" /> : <Plus />}</Button><Textarea ref={input} aria-label="Type a personal message" rows={1} value={model.draft} readOnly={model.sending || model.attaching || model.draftMismatch} placeholder="Message" onChange={event => model.edit(event.target.value)} onKeyDown={event => submitOnEnter(event, model.canSend, () => void model.send())} /><Button size="icon" className="send-button personal-send" type="submit" disabled={!model.canSend} aria-label="Send personal message" aria-busy={model.sending}>{model.sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button></form>
  </div></div></>;
}
