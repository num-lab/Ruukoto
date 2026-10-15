import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { requireSubAgentExecution, requireSubAgentExecutionScope, snapshotSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { verifyImportedSubAgentExecutions } from "@ruukoto/core/import-support.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { BUILTIN_SUBAGENT_ROLES } from "@ruukoto/agent/subagent-roles.ts";
import { assertGrantNotProtected, assertNotProtected, executeApprovedFileOp, isProtectedPath, sha256Hex } from "@ruukoto/agent/execution/approved-ops.ts";

const source: WorkflowSource = { product: "ruukoto-code", projectId: "project", sessionId: "parent", taskId: "source", permissionVersion: 1,
  accessMode: "full_access", grantedPaths: [], capabilities: ["coding"], references: [], replyTarget: null, scheduledRunId: null,
  authority: { toolClass: "dev", categories: ["coding"], grantIds: [], configuration: "configuration", workspace: { path: "/workspace", dev: 1, ino: 1 } } };

test("执行快照保存实际工具与权限，损坏拒绝；消息收紧重算摘要不包含旧摘要", () => {
  const definition = BUILTIN_SUBAGENT_ROLES[0];
  const original = snapshotSubAgentExecution({ source, roleDigest: definition.digest, accessMode: "full_access", protectSource: false, tools: ["read", "bash"], mcpSignature: "" });
  assert.deepEqual(requireSubAgentExecution(JSON.parse(JSON.stringify(original))), original);
  assert.throws(() => requireSubAgentExecution(undefined), { code: "execution_missing" });
  assert.throws(() => requireSubAgentExecution({ ...original, tools: ["write"] }), { code: "execution_corrupt" });
  assert.throws(() => requireSubAgentExecution(snapshotSubAgentExecution({ ...original, tools: ["read", "read"] })), { code: "execution_corrupt" });
  const tightened = snapshotSubAgentExecution({ ...original, accessMode: "confirm" });
  assert.equal(requireSubAgentExecution(tightened).accessMode, "confirm");
  assert.notEqual(tightened.digest, original.digest);
  assert.equal(tightened.source.accessMode, "full_access");
  const scope = { paths: [], sourceRefs: [], readMemories: [], execution: tightened };
  requireSubAgentExecutionScope(scope);
  for (const missing of ["sourceRefs", "readMemories"] as const) {
    const corrupted: Record<string, unknown> = { ...scope }; delete corrupted[missing];
    assert.throws(() => requireSubAgentExecutionScope(corrupted), { code: "execution_corrupt" });
  }
  assert.throws(() => requireSubAgentExecutionScope({ ...scope, readMemories: [null] }), { code: "execution_corrupt" });
  const task = { id: "child", session_id: "child-session", sub_agent_id: "agent", read_scope: JSON.stringify({ paths: [], sourceRefs: [], readMemories: [], execution: tightened }) };
  const tasks = [{ id: "source", session_id: "parent" }, task];
  const sessions = [{ id: "parent", project_id: "project" }];
  const agents = [{ id: "agent", session_id: "child-session", parent_session_id: "parent", definition: JSON.stringify(definition) }];
  verifyImportedSubAgentExecutions(tasks, sessions, agents);
  assert.throws(() => verifyImportedSubAgentExecutions([task], sessions, agents), { code: "execution_source_missing" });
  for (const malformed of ["null", "[]"]) assert.throws(() => verifyImportedSubAgentExecutions([{ ...task, read_scope: malformed }], sessions, agents), { code: "execution_corrupt" });
});

test("受保护来源可读，批准后的宿主文件写入仍拒绝来源及多硬链接旁路", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-source-protect-")));
  try {
    const protectedRoot = path.join(root, "source"), checks = path.join(root, "checks");
    fs.mkdirSync(protectedRoot); fs.mkdirSync(checks);
    fs.symlinkSync(checks, path.join(protectedRoot, "checks-link"));
    const file = path.join(protectedRoot, "source.txt"), alias = path.join(checks, "alias.txt"), output = path.join(checks, "result.txt");
    fs.writeFileSync(file, "original"); fs.linkSync(file, alias);
    const stat = fs.statSync(file);
    const request = { path: file, access: "read" as const, targetDev: stat.dev, targetIno: stat.ino, originalSha256: sha256Hex("original"), protectedRoots: [], writeProtectedRoots: [protectedRoot] };
    assert.equal(isProtectedPath(alias, [protectedRoot]), true);
    assert.throws(() => assertNotProtected(alias, [protectedRoot]));
    assert.throws(() => assertGrantNotProtected(alias, [protectedRoot]));
    assert.equal(executeApprovedFileOp(request).content, "original");
    assert.equal(executeApprovedFileOp({ ...request, path: alias, protectedRoots: [protectedRoot] }).ok, false);
    assert.equal(executeApprovedFileOp({ ...request, access: "read_write", content: "changed" }).ok, false);
    assert.equal(executeApprovedFileOp({ ...request, path: alias, access: "read_write", content: "changed" }).ok, false);
    const parent = fs.statSync(checks);
    assert.equal(executeApprovedFileOp({ ...request, path: output, access: "read_write", content: "proof", originalSha256: null, targetDev: parent.dev, targetIno: parent.ino }).ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "original");
    assert.equal(fs.readFileSync(output, "utf8"), "proof");
    assert.equal(isProtectedPath(output, [protectedRoot]), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
