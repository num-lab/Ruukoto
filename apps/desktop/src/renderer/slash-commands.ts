export const slashCommands = [
  { name: "skill", arguments: "[name] [arguments]", description: "Use a skill" },
  { name: "skills", arguments: "", description: "Open the skill library" },
  { name: "model", arguments: "", description: "Select model and effort" },
  { name: "mode", arguments: "", description: "Select access mode" },
  { name: "new", arguments: "", description: "Open New chat" },
  { name: "branch", arguments: "[name]", description: "Branch this conversation" },
  { name: "compact", arguments: "[guidance]", description: "Compact this conversation" },
  { name: "help", arguments: "", description: "Show commands" },
] as const;
export type SlashCommandName = typeof slashCommands[number]["name"];
export type SlashInput = { kind: "skill"; input: string } | { kind: "command"; name: SlashCommandName; arguments: string; error?: string };

// Note: See .agents/notes/implemented/feature/2026-11-08-desktop-slash-commands.md
export function parseSlashInput(text: string): SlashInput | null {
  const match = /^\/([^\s]+)([\s\S]*)$/.exec(text);
  if (!match) return null;
  const [, token, suffix] = match;
  if (token === "skill:") return { kind: "command", name: "skill", arguments: "", error: "Choose a skill with /skill name [arguments]." };
  if (token.startsWith("skill:") && token.length > 6) return { kind: "skill", input: text };
  const command = slashCommands.find(item => item.name === token);
  if (!command) return null;
  if (command.name === "skill") {
    const skill = /^\s+([^\s]+)([\s\S]*)$/.exec(suffix);
    if (skill) return { kind: "skill", input: `/skill:${skill[1]}${skill[2]}` };
  }
  const args = suffix.trim();
  return { kind: "command", name: command.name, arguments: command.name === "compact" ? suffix.replace(/^\s+/, "") : args,
    ...(!command.arguments && args ? { error: `/${command.name} does not accept arguments.` } : {}) };
}

export interface SlashChoice { value: string; label: string; description: string }
export function slashChoices(text: string, skills: readonly { name: string; description: string }[], available: (name: SlashCommandName) => boolean): SlashChoice[] | null {
  const skill = /^\/skill(?:\s+|:)([^\s]*)$/.exec(text);
  if (skill) return available("skill") ? skills.filter(item => item.name.toLocaleLowerCase().includes(skill[1].toLocaleLowerCase())).map(item => ({ value: `/skill ${item.name} `, label: item.name, description: item.description })) : null;
  if (!/^\/[^\s]*$/.test(text)) return null;
  const query = text.slice(1).toLocaleLowerCase();
  const rank = (name: string) => name === query ? 0 : name.startsWith(query) ? 1 : 2;
  return slashCommands.filter(item => available(item.name) && `${item.name} ${item.description}`.toLocaleLowerCase().includes(query)).sort((a, b) => rank(a.name) - rank(b.name)).map(item => ({ value: `/${item.name}${item.name === "skill" ? " " : ""}`, label: `/${item.name}${item.arguments ? ` ${item.arguments}` : ""}`, description: item.description }));
}

export function slashMenuKey(event: { key: string; shiftKey: boolean; repeat: boolean; nativeEvent: { isComposing?: boolean; keyCode?: number }; preventDefault(): void }, count: number, index: number, choose: (index: number) => void, move: (index: number) => void, dismiss: () => void): boolean {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return false;
  if (event.key === "Escape") { event.preventDefault(); dismiss(); return true; }
  if (!count) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move((index + (event.key === "ArrowDown" ? 1 : -1) + count) % count); return true; }
  if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) { event.preventDefault(); choose(index); return true; }
  return false;
}
