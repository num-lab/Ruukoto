// Note: See .agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md
import type { OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import { Checkbox, ToggleGroup } from "radix-ui";
import { Check, ChevronLeft, ChevronRight, SquarePen } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { questionStatus } from "./owner-questions.ts";
import { Item, ItemActions, ItemContent, ItemFooter, ItemHeader, ItemTitle } from "./components/ui/item.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { MessageScrollerItem } from "./components/ui/message-scroller.tsx";
import { Button } from "./components/ui/button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Textarea } from "./components/ui/textarea.tsx";

export function OwnerQuestionCard({ model, question }: { model: CodeState; question: OwnerQuestionView }) {
  const controller = model.questions, draft = controller.draft(question), current = question.questions[draft.index], answer = draft.answers[draft.index];
  const blocked = controller.blocked(question), terminal = question.status !== "pending", textId = `owner-question-${question.id}`;
  const last = draft.index + 1 === question.questions.length, incomplete = !answer.text.trim() || answer.text.length > 4096;
  const choices = current.options?.map((option, index) => {
    const button = <Button type="button" variant="ghost" className="owner-question-option">
      {current.multiple ? <span className="owner-question-checkbox" aria-hidden="true"><Checkbox.Indicator><Check /></Checkbox.Indicator></span> : <span className="owner-question-number" aria-hidden="true">{index + 1}</span>}
      <span className="owner-question-option-copy"><span>{typeof option === "string" ? option : option.label}</span>{typeof option !== "string" && option.recommended && <Badge variant="outline" className="owner-question-recommended">Recommended</Badge>}{typeof option !== "string" && option.description && <span className="owner-question-option-description">{option.description}</span>}</span>
    </Button>;
    return current.multiple ? <Checkbox.Root key={index} asChild checked={answer.options?.includes(index) ?? false} disabled={blocked} onCheckedChange={checked => controller.choose(question, checked ? [...(answer.options ?? []), index] : (answer.options ?? []).filter(item => item !== index))}>{button}</Checkbox.Root>
      : <ToggleGroup.Item key={index} value={String(index)} asChild>{button}</ToggleGroup.Item>;
  });
  return <Item asChild variant="muted" className="owner-question-card"><section aria-label="Owner question">
    <ItemHeader className="owner-question-header">
      <ItemTitle id={`${textId}-label`} className="owner-question-title">{terminal ? questionStatus(question.status) : draft.review ? "Review answers" : current.question}</ItemTitle>
    </ItemHeader>
    <div className="owner-question-content">
    <ItemContent className="owner-question-body">
      {terminal ? question.questions.map((item, index) => <Field key={index}><FieldLabel>{item.question}</FieldLabel>{question.answers?.[index] && <FieldDescription className="whitespace-pre-wrap">{question.answers[index].text || "Skipped"}</FieldDescription>}</Field>)
        : draft.review ? <FieldGroup>{question.questions.map((item, index) => <Field key={index}><FieldLabel>{item.question}</FieldLabel><FieldDescription className="whitespace-pre-wrap">{draft.answers[index].text || "Skipped"}</FieldDescription></Field>)}</FieldGroup>
        : <FieldGroup><Field data-disabled={blocked} className="owner-question-options">
          {current.options && (current.multiple ? <div role="group" aria-labelledby={`${textId}-label`} className="owner-question-options">{choices}</div>
            : <ToggleGroup.Root type="single" orientation="vertical" disabled={blocked} value={answer.option === undefined ? "" : String(answer.option)} onValueChange={value => value === "" ? controller.edit(question, "") : controller.choose(question, Number(value))} aria-labelledby={`${textId}-label`} className="owner-question-options">{choices}</ToggleGroup.Root>)}
          <div className="owner-question-free-input"><FieldLabel htmlFor={textId} className="owner-question-number"><SquarePen aria-hidden="true" /><span className="sr-only">Type a free-form answer</span></FieldLabel><Textarea id={textId} aria-describedby={`${textId}-label`} disabled={blocked} value={answer.option === undefined && !answer.options ? answer.text : ""} maxLength={4096} onChange={event => controller.edit(question, event.target.value)} placeholder={current.options ? "Type another answer…" : "Type your answer…"} rows={1} /></div>
        </Field></FieldGroup>}
    </ItemContent>
    {!terminal && <ItemFooter className="owner-question-footer">
      {draft.review ? <><Button variant="ghost" disabled={blocked} onClick={() => controller.back(question)}>Back to edit</Button><Button disabled={blocked} aria-busy={controller.busy.has(question.id)} onClick={() => void controller.send(question)}>Submit answers</Button></>
        : <><div role="group" aria-label="Question navigation" className="flex items-center gap-1"><Button variant="ghost" size="icon-sm" aria-label="Previous question" disabled={blocked || draft.index === 0} onClick={() => controller.back(question)}><ChevronLeft /></Button><span className="owner-question-progress" aria-live="polite">{`${draft.index + 1}/${question.questions.length}`}</span><Button variant="ghost" size="icon-sm" aria-label={last ? "Review answers" : "Next question"} disabled={blocked || incomplete} onClick={() => controller.next(question)}><ChevronRight /></Button></div><ItemActions className="ml-auto"><Button variant="ghost" className="owner-question-action" disabled={blocked} onClick={() => controller.next(question, true)}>Skip</Button><Button className="owner-question-action" disabled={blocked || incomplete} onClick={() => controller.next(question)}>{last ? "Review answers" : "Next"}</Button></ItemActions></>}
    </ItemFooter>}
    {!terminal && blocked && <p role="status">{model.status.state !== "online" ? "Connection lost; waiting to reconnect." : "Submitting or verifying…"}</p>}
    </div></section></Item>;
}
export function OwnerQuestionCards({ model, sessionId, positioned = [] }: { model: CodeState; sessionId: string; positioned?: string[] }) {
  if (model.target !== "code") return null;
  return model.view.ownerQuestions.filter(question => question.sessionId === sessionId && !positioned.includes(question.id)).map(question => <MessageScrollerItem key={`${model.view.instanceId}:${question.id}:${question.version}`}><OwnerQuestionCard model={model} question={question} /></MessageScrollerItem>);
}
