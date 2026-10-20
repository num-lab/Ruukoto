import * as fs from "node:fs";
import { loadSkillLibrary } from "@ruukoto/agent/skills.ts";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { personalSkillsDirectory, readPersonalSkills, savePersonalSkills } from "./personal-skills-config.ts";
import { PersonalError } from "./personal-error.ts";

function describeSkills(io: PersonalCliIO, directory: string) {
  const library = loadSkillLibrary(directory);
  io.write(library.skills.length ? library.skills.map(skill => `${skill.name}：${skill.description}${skill.disableModelInvocation ? "（仅显式调用）" : ""}`).join("\n") + "\n" : "此目录没有有效技能。\n");
  if (library.diagnostics.length) io.write(`加载诊断：\n${library.diagnostics.join("\n")}\n`);
}

export async function configurePersonalSkills(io: PersonalCliIO, directory: string) {
  const profile = lockPersonalProfile(directory);
  try {
    const current = readPersonalSkills(profile);
    io.write("选择技能库所在目录；该目录下的 skills 子目录存放含 SKILL.md 的技能包。技能只提供参考，不增加工具或权限。输入 /back 返回。\n");
    if (current) {
      io.write(`当前技能库：${current.directory}\n`);
      const action = await choose(io, "技能配置", ["查看技能与诊断", "选择其他目录", "返回"]);
      if (action === 2) return;
      if (action === 0) { personalSkillsDirectory(current); describeSkills(io, current.directory); return; }
    }
    const answer = (await io.question(`技能库绝对路径${current ? "（回车保留）" : ""}：`)).trim();
    if (answer === "/back") return;
    let selected: string;
    try { selected = fs.realpathSync(answer || current?.directory || ""); } catch (error) { throw new PersonalError("skills_directory_unavailable", "技能库目录不存在或不可读，请准备目录后重新运行技能配置向导。", { cause: error }); }
    const config = { version: 1 as const, directory: selected };
    personalSkillsDirectory(config);
    describeSkills(io, config.directory);
    if (await choose(io, "保存技能目录", ["返回", "保存配置"]) === 0) return;
    await savePersonalSkills(profile, config);
    io.write("技能目录已保存；下一次模型调用使用新的内容版本，原快照保留。\n");
  } finally { profile.release(); }
}
