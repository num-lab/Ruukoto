import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { getSkillDetail, listSkillLibrary, loadSkillLibrary, SkillLibraryError, skillsDirFor } from "@ruukoto/agent/skills.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import { startTestRuntime } from "./helpers/testkit.ts";

function writeSkill(directory: string, name: string, body = "技能正文") {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}任务指引\n---\n${body}\n`);
}

test("固定技能库：仅发现后台 HOME，分页修订随正文变化，详情只读", tc => {
  const home = isolateSkillHome(tc);
  assert.equal(skillsDirFor(), path.join(home, ".agents", "skills"));
  assert.deepEqual(loadSkillLibrary().skills, []);
  writeSkill(path.join(home, "old-agent", "skills", "old"), "old");
  writeSkill(path.join(home, "old-agent", "managed-skills", "packages", "old"), "managed-old");
  writeSkill(path.join(skillsDirFor(), "alpha"), "alpha");
  writeSkill(path.join(skillsDirFor(), "beta"), "beta");
  assert.deepEqual(loadSkillLibrary().skills.map(skill => skill.name), ["alpha", "beta"]);
  const first = listSkillLibrary({ limit: 1 }), second = listSkillLibrary({ offset: 1, limit: 1 });
  assert.match(first.revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.revision, second.revision);
  assert.equal(first.hasMore, true);
  assert.deepEqual(second.skills.map(skill => skill.name), ["beta"]);
  assert.equal(second.hasMore, false);
  assert.deepEqual(first.skills.map(({ source, readOnly, state }) => ({ source, readOnly, state })), [{ source: "external", readOnly: true, state: "enabled" }]);
  assert.equal(getSkillDetail(first.skills[0].id).body, "技能正文");
  writeSkill(path.join(skillsDirFor(), "alpha"), "alpha", "更新正文");
  assert.notEqual(listSkillLibrary().revision, first.revision);
  assert.equal(getSkillDetail(first.skills[0].id).body, "更新正文");
  assert.throws(() => getSkillDetail("missing"), error => error instanceof SkillLibraryError && error.code === "skill_not_found");
  assert.throws(() => listSkillLibrary({ limit: 0 }), error => error instanceof SkillLibraryError && error.code === "invalid_params");
});

test("Code 技能入口：固定目录可读，退役写请求不产生包或修改文件", async tc => {
  isolateSkillHome(tc);
  const fixture = await startTestRuntime("global-skills-control", () => ({ kind: "text", text: "完成" }));
  try {
    const old = path.join(fixture.dirs.agentDir, "skills", "old");
    writeSkill(old, "old");
    writeSkill(path.join(skillsDirFor(), "current"), "current");
    const page = await fixture.client.request<{ skills: { name: string; id: string }[] }>("skills_list");
    assert.deepEqual(page.skills.map(skill => skill.name), ["current"]);
    const detail = await fixture.client.request<{ body: string }>("skill_get", { skill_id: page.skills[0].id });
    assert.equal(detail.body, "技能正文");
    const bytes = fs.readFileSync(path.join(old, "SKILL.md"));
    for (const op of ["skill_import_preview", "skill_import", "skill_set_enabled", "skill_remove"]) {
      await assert.rejects(fixture.client.request(op, { source_dir: old }), error => error instanceof Error && "code" in error && error.code === "unknown_op");
    }
    assert.deepEqual(fs.readFileSync(path.join(old, "SKILL.md")), bytes);
    assert.equal(fs.existsSync(path.join(fixture.dirs.agentDir, "managed-skills")), false);
  } finally { await fixture.shutdown(); }
});
