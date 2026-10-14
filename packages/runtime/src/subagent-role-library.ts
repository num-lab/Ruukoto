/** 实例角色文件是宿主配置；坏覆盖保留诊断，不回落内置同名定义。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-14-subagent-role-snapshots.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SubAgentDefinitionSnapshot } from "@ruukoto/core/subagent-definition.ts";
import { BUILTIN_SUBAGENT_ROLES, parseSubAgentRole, subAgentRoleLibrary, SUBAGENT_ROLE_FILE_BYTES, SubAgentRoleError, validateSubAgentRoleLibrary, type SubAgentRoleLibrary } from "@ruukoto/agent/subagent-roles.ts";

function io<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) { throw new SubAgentRoleError("role_io_failed", "角色配置读取失败；核实目录与文件的读取权限后重新创建子代理。", { cause }); }
}
function same(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink; }
export function subAgentRolesDirFor(agentDir: string): string { return path.join(agentDir, "agents"); }

export function loadSubAgentRoleLibrary(agentDir: string): SubAgentRoleLibrary {
  const roles = new Map(BUILTIN_SUBAGENT_ROLES.map(role => [role.name, structuredClone(role)]));
  const diagnostics: SubAgentRoleLibrary["diagnostics"] = [];
  const diagnostic = (name: string, error: unknown): void => {
    if (!(error instanceof SubAgentRoleError)) throw error;
    diagnostics.push({ name, code: error.code, message: error.message });
  };
  let root: string, directory: fs.Stats;
  const currentRoot = (): fs.Stats => {
    const stat = io(() => fs.lstatSync(root));
    if (!stat.isDirectory() || stat.isSymbolicLink() || io(() => fs.realpathSync(root)) !== root) throw new SubAgentRoleError("role_path_unsafe", "agents 须为实例内的普通目录；移除目录符号链接后重新加载。");
    return stat;
  };
  try {
    const parent = io(() => fs.realpathSync(agentDir));
    root = subAgentRolesDirFor(parent);
    const stat = io(() => fs.lstatSync(root, { throwIfNoEntry: false }));
    if (!stat) return subAgentRoleLibrary([...roles.values()], diagnostics);
    directory = currentRoot();
  } catch (error) {
    diagnostic("*", error);
    return subAgentRoleLibrary([], diagnostics);
  }
  let names: string[];
  try { names = io(() => fs.readdirSync(root)).filter(file => file.endsWith(".md")).sort(); }
  catch (error) { diagnostic("*", error); return subAgentRoleLibrary([], diagnostics); }
  for (const file of names) {
    const name = file.slice(0, -3);
    roles.delete(name);
    try {
      if (!same(directory, currentRoot())) throw new SubAgentRoleError("role_changed", "角色目录在读取中变化；稳定配置文件后重新创建子代理。");
      const filename = path.join(root, file);
      const before = io(() => fs.lstatSync(filename));
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new SubAgentRoleError("role_path_unsafe", "角色须为单一硬链接的普通 Markdown 文件；移除链接或目录后重新加载。");
      if (!before.size || before.size > SUBAGENT_ROLE_FILE_BYTES) throw new SubAgentRoleError("role_invalid_frontmatter", "角色文件须为非空且不超过 64 KiB 的 Markdown。");
      const fd = io(() => fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
      let bytes: Buffer;
      try {
        const opened = io(() => fs.fstatSync(fd));
        if (!opened.isFile() || !same(before, opened)) throw new SubAgentRoleError("role_changed", "角色文件在打开时变化；稳定配置文件后重新创建子代理。");
        bytes = Buffer.alloc(SUBAGENT_ROLE_FILE_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = io(() => fs.readSync(fd, bytes, length, bytes.length - length, null));
          if (!count) break;
          length += count;
        }
        if (length !== before.size || !same(before, io(() => fs.fstatSync(fd))) || !same(before, io(() => fs.lstatSync(filename))) || !same(directory, currentRoot())) throw new SubAgentRoleError("role_changed", "角色文件在读取中变化；稳定配置文件后重新创建子代理。");
        bytes = bytes.subarray(0, length);
      } finally { io(() => fs.closeSync(fd)); }
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch (cause) { throw new SubAgentRoleError("role_invalid_utf8", "角色文件不是 UTF-8；转换编码后重新加载。", { cause }); }
      roles.set(name, parseSubAgentRole(name, raw));
    } catch (error) { diagnostic(name, error); }
  }
  try {
    if (!same(directory, currentRoot())) throw new SubAgentRoleError("role_changed", "角色目录在读取中变化；稳定配置文件后重新创建子代理。");
  } catch (error) { diagnostic("*", error); return subAgentRoleLibrary([], diagnostics); }
  return subAgentRoleLibrary([...roles.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics);
}

export function selectSubAgentRole(library: SubAgentRoleLibrary, name: string): SubAgentDefinitionSnapshot {
  validateSubAgentRoleLibrary(library);
  const failure = library.diagnostics.find(d => d.name === name || d.name === "*");
  if (failure) throw new SubAgentRoleError(failure.code, `角色 ${name} 不可用：${failure.message}`);
  const role = library.roles.find(role => role.name === name);
  if (!role) throw new SubAgentRoleError("role_unknown", `未知角色 ${name}；从角色目录选择，或在实例 agents 目录新增 ${name}.md 后创建子代理。`);
  return structuredClone(role);
}
