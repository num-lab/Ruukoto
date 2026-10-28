import type { PersonalCliIO } from "./personal-cli.ts";
import { readPersonalSettings } from "./personal-settings.ts";

export async function showPersonalSkills(io: PersonalCliIO, directory: string) {
  const { skills } = await readPersonalSettings(directory);
  io.write(skills.skills.length ? skills.skills.map(skill => `${skill.name}：${skill.description}${skill.explicitOnly ? "（仅显式调用）" : ""}`).join("\n") + "\n" : "尚无可用技能。\n");
  if (skills.diagnostics.length) io.write(skills.diagnostics.join("\n") + "\n");
}
