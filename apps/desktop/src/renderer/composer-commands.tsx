import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { Session } from "@ruukoto/core/types.ts";
import type { CodeState } from "./code-state.ts";
import { parseSlashInput, slashChoices, slashCommands, slashMenuKey, type SlashCommandName } from "./slash-commands.ts";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

type Skills = OpResult<"skills_list">["skills"];
export interface ComposerCommandActions { onNew?: () => void; onSkills?: () => void }

// Note: See .agents/notes/implemented/feature/2026-11-08-desktop-slash-commands.md
export function useComposerCommands({ model, session, text, edit, input, locked, onNew, onSkills }: ComposerCommandActions & { model: CodeState; session?: Session; text: string; edit: (text: string) => void; input: RefObject<HTMLTextAreaElement | null>; locked: boolean }) {
  const [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState<string | null>(null), [index, setIndex] = useState(0);
  const [selector, setSelector] = useState<"model" | "mode" | null>(null), [help, setHelp] = useState(false);
  const [skills, setSkills] = useState<Skills>([]), [skillsError, setSkillsError] = useState("");
  const [skillReload, setSkillReload] = useState(0);
  const sending = useRef(false), latestText = useRef(text), id = useId();
  latestText.current = text;
  const online = model.status.state === "online", instanceId = model.view.instanceId;
  const parsed = parseSlashInput(text);
  const application = parsed?.kind === "command";
  const skillQuery = /^\/skill(?:\s+|:)[^\s]*$/.test(text);
  const available = (name: SlashCommandName) => {
    if (name === "help") return true;
    if (!online || locked) return false;
    if (name === "new" || name === "skills") return name === "new" ? !!onNew : !!onSkills;
    if (session?.codeScheduleActive) return false;
    if (name !== "branch" && name !== "compact") return true;
    if (!session || session.kind !== "dev" || model.view.excludedPickerSessionIds().has(session.id) || model.view.sideChats.has(session.id)) return false;
    return name === "branch" || !model.view.activeTaskFor(session.id) && !model.view.queuedTasksFor(session.id).length && !model.compactions.occupied(session.id);
  };
  useEffect(() => { setIndex(0); if (dismissed !== text) setDismissed(null); }, [text, dismissed]);
  useEffect(() => {
    setSkills([]); setSkillsError("");
    if (!skillQuery || !online || !instanceId) return;
    let disposed = false;
    void (async () => {
      const collected: Skills = [];
      let revision: string | undefined;
      do {
        const result = await window.ruukoto.request("code", "skills_list", { offset: collected.length, limit: 50 });
        if (disposed || instanceId !== model.view.instanceId) return;
        if (!result.ok) throw new Error(result.error.message);
        const page = result.value as OpResult<"skills_list">;
        if (revision !== undefined && page.revision !== revision) throw new Error("Skill library changed. Reopen /skill to reload.");
        revision = page.revision;
        collected.push(...page.skills);
        if (!page.hasMore) break;
        if (!page.skills.length) throw new Error("Skill library could not be read. Reopen /skills to inspect it.");
      } while (true);
      if (!disposed) setSkills(collected);
    })().catch(error => { if (!disposed) setSkillsError(error instanceof Error ? error.message : "Could not read skills. Reopen /skills to inspect them."); });
    return () => { disposed = true; };
  }, [skillQuery, online, instanceId, model, skillReload]);
  const choices = focused && dismissed !== text ? slashChoices(text, skills, available) : null;
  const selected = choices?.length ? Math.min(index, choices.length - 1) : 0;
  useEffect(() => { if (choices?.length) document.getElementById(`${id}-${selected}`)?.scrollIntoView({ block: "nearest" }); }, [id, selected, choices?.length]);
  function choose(at: number) {
    const choice = choices?.[at];
    if (!choice) return;
    edit(choice.value); setDismissed(choice.value === "/skill " ? null : choice.value);
    input.current?.focus();
    requestAnimationFrame(() => input.current?.setSelectionRange(choice.value.length, choice.value.length));
  }
  function feedback(message: string) { model.writes.message = message; model.refresh(); }
  async function execute(): Promise<void> {
    if (!parsed || parsed.kind !== "command" || sending.current) return;
    if (parsed.error) { feedback(parsed.error); return; }
    if (!available(parsed.name)) { feedback(!online ? "Reconnect to Code, then submit this command again." : parsed.name === "branch" || parsed.name === "compact" ? "Open an idle ordinary conversation to use this command." : "This action is unavailable while this input or scheduled run is pending. Try again when it finishes."); return; }
    sending.current = true;
    try {
      let accepted = true;
      switch (parsed.name) {
        case "skill": edit("/skill "); setDismissed(null); setFocused(true); setSkillReload(value => value + 1); input.current?.focus(); return;
        case "skills": onSkills?.(); break;
        case "new": onNew?.(); break;
        case "help": setHelp(true); break;
        case "model": setSelector("model"); break;
        case "mode": setSelector("mode"); break;
        case "branch": accepted = await model.branch(session!.id, undefined, parsed.arguments || undefined); break;
        case "compact": accepted = await model.compactions.start(session!.id, parsed.arguments); break;
      }
      const currentText = session ? model.writes.draft(session.id).text : latestText.current;
      if (accepted && instanceId === model.view.instanceId && currentText === text) edit("");
    } finally { sending.current = false; }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    return choices !== null && slashMenuKey(event, choices.length, selected, choose, setIndex, () => setDismissed(text));
  }
  return {
    application, parsed, execute, selector, closeSelector: () => setSelector(null), keyDown,
    inputProps: { onFocus: () => setFocused(true), onBlur: () => setFocused(false), role: "combobox", "aria-haspopup": "listbox" as const, "aria-controls": choices !== null ? id : undefined, "aria-expanded": choices !== null, "aria-autocomplete": "list" as const, "aria-activedescendant": choices?.length ? `${id}-${selected}` : undefined },
    menu: choices !== null && <div className="slash-menu composer-menu" id={id} role="listbox" aria-label={skillQuery ? "Skills" : "Slash commands"}>{choices.map((choice, at) => <Button type="button" variant="ghost" key={choice.value} id={`${id}-${at}`} role="option" aria-selected={at === selected} tabIndex={-1} className="slash-option" onMouseDown={event => event.preventDefault()} onMouseEnter={() => setIndex(at)} onClick={() => choose(at)}><span>{choice.label}</span><span>{choice.description}</span></Button>)}{!choices.length && <p role="status">{skillQuery ? skillsError || "No matching skills. Use /skills to inspect the library." : "No matching commands"}</p>}</div>,
    help: <Dialog open={help} onOpenChange={setHelp}><DialogContent className="app-dialog" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}><DialogHeader><DialogTitle>Code commands</DialogTitle></DialogHeader><dl className="slash-help">{slashCommands.map(command => <div key={command.name}><dt>/{command.name} {command.arguments}</dt><dd>{command.description}</dd></div>)}</dl></DialogContent></Dialog>,
  };
}
