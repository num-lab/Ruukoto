import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { BUILTIN_SUBAGENT_ROLES, HOST_REVIEW_DEFINITION, parseSubAgentRole, roleCatalogBlock, validateSubAgentRole, validateSubAgentRoleLibrary } from "@ruukoto/agent/subagent-roles.ts";
import { subAgentDefinitionDigest } from "@ruukoto/core/subagent-definition.ts";
import { loadSubAgentRoleLibrary, selectSubAgentRole } from "@ruukoto/runtime/subagent-role-library.ts";

const raw = "---\ndescription: 自定义职责\n---\n执行独立分析。\n";
function kit() {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-role-library-"));
  const root = path.join(agentDir, "agents");
  fs.mkdirSync(root);
  return { agentDir, root, close() { fs.rmSync(agentDir, { recursive: true, force: true }); } };
}

test("内置与自定义使用同一解析契约，非法字段和 YAML 不进入角色目录", () => {
  for (const role of [...BUILTIN_SUBAGENT_ROLES, HOST_REVIEW_DEFINITION]) assert.deepEqual(validateSubAgentRole(role), role);
  assert.equal(BUILTIN_SUBAGENT_ROLES[0].permissions.mode, "inherit");
  assert.deepEqual(BUILTIN_SUBAGENT_ROLES[1].permissions, { mode: "confirm", protectSource: true });
  assert.equal(HOST_REVIEW_DEFINITION.kind, "host_review");
  for (const invalid of [
    "description: 未封闭", "---\ndescription: a\n", "---oops\ndescription: a\n---\n正文",
    "---\ndescription: a\n---oops\n---\n正文",
    "---\n- a\n---\n正文", "---\ndescription: [\n---\n正文", "---\ndescription: a\ndescription: b\n---\n正文",
    "---\ndescription: ''\n---\n正文", "---\ndescription: 3\n---\n正文", "---\ndescription: a\n---\n",
    "---\ndescription: a\nmodel: x\n---\n正文", "---\ndescription: a\nname: x\n---\n正文",
    "---\ndescription: a\ntools: [read, read]\n---\n正文", "---\ndescription: a\ntools: [3]\n---\n正文", "---\ndescription: a\ntools: read\n---\n正文",
    "---\ndescription: a\npermissions: null\n---\n正文", "---\ndescription: a\npermissions: {mode: null}\n---\n正文", "---\ndescription: a\npermissions: {protect_source: null}\n---\n正文",
    "---\ndescription: a\npermissions: {unknown: true}\n---\n正文", "---\ndescription: a\npermissions: {mode: plan}\n---\n正文",
    "---\ndescription: a\npermissions: {protect_source: yes}\n---\n正文", "---\ndescription: a\npermissions: {mode: full_access, protect_source: true}\n---\n正文",
  ]) assert.throws(() => parseSubAgentRole("valid", invalid), error => error instanceof Error && "code" in error, invalid);
  for (const name of ["../escape", "Mixed", "two_words", "a--b", "a.md", ""]) assert.throws(() => parseSubAgentRole(name, raw), { code: "role_invalid_name" });
  const forged = { ...parseSubAgentRole("general", raw), body: "替换正文" };
  const { digest: _digest, ...content } = forged;
  forged.digest = subAgentDefinitionDigest(content);
  assert.throws(() => validateSubAgentRole(forged), { code: "definition_corrupt" }, "重新算摘要也不能使原文和字段不一致");
});

test("新增、覆盖和坏同名覆盖明确可查；无效 general 不回落内置", () => {
  const k = kit();
  try {
    fs.writeFileSync(path.join(k.root, "general.md"), raw);
    fs.writeFileSync(path.join(k.root, "researcher.md"), raw.replace("独立分析", "独立调研"));
    const library = loadSubAgentRoleLibrary(k.agentDir);
    assert.equal(selectSubAgentRole(library, "general").body, "执行独立分析。");
    assert.equal(selectSubAgentRole(library, "researcher").body, "执行独立调研。");
    assert.equal(library.roles.length, 3);
    assert.deepEqual(validateSubAgentRoleLibrary(library), library);
    assert.match(roleCatalogBlock(library).text, /researcher：自定义职责/);
    fs.writeFileSync(path.join(k.root, "general.md"), "---\ndescription: a\nunknown: true\n---\n正文");
    const broken = loadSubAgentRoleLibrary(k.agentDir);
    assert.equal(broken.roles.some(role => role.name === "general"), false);
    assert.throws(() => selectSubAgentRole(broken, "general"), { code: "role_unknown_field" });
    assert.throws(() => selectSubAgentRole(broken, "missing"), { code: "role_unknown" });
    assert.equal(selectSubAgentRole(library, "general").raw, raw, "旧目录快照保持原内容");
    assert.throws(() => validateSubAgentRoleLibrary({ ...library, digest: "0".repeat(64) }), { code: "role_catalog_corrupt" });
  } finally { k.close(); }
});

test("符号链接、多硬链接、目录、超大文件、编码和不安全根目录均有诊断", () => {
  const k = kit();
  try {
    const source = path.join(k.agentDir, "source.md");
    fs.writeFileSync(source, raw);
    fs.symlinkSync(source, path.join(k.root, "general.md"));
    fs.linkSync(source, path.join(k.root, "linked.md"));
    fs.mkdirSync(path.join(k.root, "directory.md"));
    fs.writeFileSync(path.join(k.root, "invalid.md"), Buffer.from([0xff]));
    fs.writeFileSync(path.join(k.root, "huge.md"), "x".repeat(65537));
    fs.writeFileSync(path.join(k.root, "nul.md"), `${raw}\0`);
    const library = loadSubAgentRoleLibrary(k.agentDir);
    for (const name of ["general", "linked", "directory", "invalid", "huge", "nul"]) assert.ok(library.diagnostics.some(d => d.name === name), name);
    assert.throws(() => selectSubAgentRole(library, "general"), { code: "role_path_unsafe" });
    fs.rmSync(k.root, { recursive: true });
    fs.symlinkSync(k.agentDir, k.root);
    const unsafe = loadSubAgentRoleLibrary(k.agentDir);
    assert.equal(unsafe.roles.length, 0);
    assert.equal(unsafe.diagnostics[0].code, "role_path_unsafe");
    fs.unlinkSync(k.root);
    assert.equal(loadSubAgentRoleLibrary(k.agentDir).roles.length, 2, "缺目录仍提供内置角色");
    fs.writeFileSync(k.root, "不是目录");
    assert.equal(loadSubAgentRoleLibrary(k.agentDir).roles.length, 0);
  } finally { k.close(); }
});

test("读取期间文件同大小改写或路径替换拒绝混合快照", context => {
  const k = kit();
  try {
    const file = path.join(k.root, "general.md");
    fs.writeFileSync(file, raw);
    const original = fs.readSync;
    let replaced = false;
    context.mock.method(fs, "readSync", (...args: Parameters<typeof original>) => {
      const count = Reflect.apply(original, fs, args);
      if (!replaced) { replaced = true; fs.writeFileSync(file, raw.replace("独立分析", "不同分析")); }
      return count;
    });
    syncBuiltinESMExports();
    assert.throws(() => selectSubAgentRole(loadSubAgentRoleLibrary(k.agentDir), "general"), { code: "role_changed" });
    context.mock.restoreAll();
    syncBuiltinESMExports();
    fs.writeFileSync(file, raw);
    replaced = false;
    context.mock.method(fs, "readSync", (...args: Parameters<typeof original>) => {
      const count = Reflect.apply(original, fs, args);
      if (!replaced) { replaced = true; fs.renameSync(file, path.join(k.agentDir, "old.md")); fs.writeFileSync(file, raw); }
      return count;
    });
    syncBuiltinESMExports();
    const library = loadSubAgentRoleLibrary(k.agentDir);
    assert.equal(library.roles.length, 0, "目录变化令整份目录不可用");
    assert.ok(library.diagnostics.some(d => d.code === "role_changed"));
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); k.close(); }
});
