import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product as codingProduct } from "../apps/ruukoto-code/src/product.ts";
import type { SubAgentDelegation } from "@ruukoto/runtime/subagents.ts";
import { workCopyHostFor } from "@ruukoto/core/work-copy-host.ts";
import { requireSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { afterTool, inputText, lastToolText, lastUserText, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { holdParentResponse } from "./helpers/active-parent.ts";
import { initGitRepo, shellQuotePathForTest as quote } from "./helpers/git-fixture.ts";

for (const product of [codingProduct]) test(`${product.runtime.type} 完全访问父级派发 reviewer 审当前内容，真实 native 拒绝源码、Git 与基线写旁路`, async () => {
  let delegated: SubAgentDelegation | null = null;
  let source = "";
  const gate = holdParentResponse(async req => {
    if (lastUserText(req).startsWith("开始")) return { kind: "text", text: "父任务结束" };
    assert.match(inputText(req), /REVIEW-SNAPSHOT/);
    if (afterTool(req)) {
      assert.match(lastToolText(req), /REVIEW-SNAPSHOT-OK/);
      return { kind: "text", text: "当前内容已检查，来源未改" };
    }
    await waitFor("副本登记返回", () => delegated !== null);
    const target = delegated!.work.writeTarget!;
    assert.ok(target.kind === "worktree");
    return { kind: "tool_calls", calls: [{ id: "check", name: "bash", arguments: { command:
      "set -eu\n" +
      "test \"$(cat value.txt)\" = dirty\n" +
      "test -f nested/new.bin && test ! -e node_modules\n" +
      "printf checked > check-output.txt\n" +
      `if printf BAD > ${quote(path.join(source, "value.txt"))}; then exit 51; fi\n` +
      `if printf BAD > ${quote(path.join(source, ".git/index"))}; then exit 52; fi\n` +
      `if printf BAD > ${quote(path.join(target.gitdir, "index"))}; then exit 53; fi\n` +
      `if printf BAD > ${quote(path.join(target.snapshot.repository.path, "ruukoto-baseline"))}; then exit 54; fi\n` +
      `ln -s ${quote(source)} source-alias\n` +
      "if printf BAD > source-alias/value.txt; then exit 55; fi\n" +
      "printf REVIEW-SNAPSHOT-OK\n",
    } }] };
  });
  const t = await startTestRuntime(`snapshot-review-${product.runtime.type}`, gate.responder, {
    config: { ...realTools(), product: product.runtime, execution: { backend: "native" } },
  });
  try {
    const rt = t.runtime;
    source = fs.realpathSync(t.work[0]);
    fs.writeFileSync(path.join(source, "value.txt"), "base\n");
    fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n");
    initGitRepo(source);
    fs.writeFileSync(path.join(source, "value.txt"), "dirty\n");
    fs.mkdirSync(path.join(source, "nested"));
    fs.writeFileSync(path.join(source, "nested/new.bin"), Buffer.from([0, 0xff, 0]));
    fs.mkdirSync(path.join(source, "node_modules"));
    fs.writeFileSync(path.join(source, "node_modules/private"), "ignored\n");
    const index = fs.readFileSync(path.join(source, ".git/index"));
    const config = fs.readFileSync(path.join(source, ".git/config"));
    const session = await rt.createSession({ projectName: "review", cwd: source });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始 reviewer", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父任务运行", () => rt.store.getTask(parent.id)!.status === "running");
    delegated = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "review", role: "reviewer", target: ".", request: "REVIEW-SNAPSHOT", paramsDigest: "review" });
    await waitFor("reviewer 终态", () => ["completed", "failed", "interrupted"].includes(rt.store.getTask(delegated!.task.id)!.status));
    const child = rt.store.getTask(delegated.task.id)!;
    assert.equal(child.status, "completed", child.errorMessage ?? undefined);
    assert.equal(child.accessMode, "confirm");
    assert.equal(requireSubAgentExecution(child.readScope?.execution).protectSource, true);
    const target = delegated.work.writeTarget!;
    assert.ok(target.kind === "worktree");
    assert.equal(fs.readFileSync(path.join(target.path, "check-output.txt"), "utf8"), "checked");
    assert.equal(fs.readFileSync(path.join(source, "value.txt"), "utf8"), "dirty\n");
    assert.deepEqual(fs.readFileSync(path.join(source, ".git/index")), index);
    assert.deepEqual(fs.readFileSync(path.join(source, ".git/config")), config);
    const hosts = rt.store.listTasksBySession(session.id).filter(task => workCopyHostFor(task));
    assert.deepEqual(hosts.map(task => workCopyHostFor(task)!.operation), ["capture", "create"]);
    for (const host of hosts) {
      assert.equal(host.modelSelection, null);
      assert.equal(host.parentTaskId, parent.id);
      assert.equal(workCopyHostFor(host)!.stopVerified, true);
      assert.ok(rt.store.listToolOpsByTask(host.id).some(op => op.toolName === `worktree_${workCopyHostFor(host)!.operation}`));
    }
    assert.ok(!rt.store.listToolOpsByTask(parent.id).some(op => op.toolName.startsWith("worktree_")));
  } finally { gate.release(); await t.shutdown(); }
});

test("受保护角色的结构化文件工具与宿主批准入口都不能写来源或私有基线", async () => {
  let delegated: SubAgentDelegation | null = null;
  let source = "";
  let turn = 0;
  const gate = holdParentResponse(async req => {
    if (lastUserText(req).startsWith("开始")) return { kind: "text", text: "父任务结束" };
    await waitFor("副本登记返回", () => delegated !== null);
    const target = delegated!.work.writeTarget!;
    assert.ok(target.kind === "worktree");
    const paths = [path.join(source, "value.txt"), path.join(source, ".git/index"), path.join(target.snapshot.repository.path, "ruukoto-baseline")];
    if (turn < paths.length) return { kind: "tool_calls", calls: [{ id: `write-${turn}`, name: "write", arguments: { path: paths[turn++], content: "BAD" } }] };
    if (turn < paths.length * 2) return { kind: "tool_calls", calls: [{ id: `host-${turn}`, name: "request_file_access", arguments: { path: paths[turn++ - paths.length], operation: "write", content: "BAD", reason: "核实来源保护" } }] };
    return { kind: "text", text: "所有写入旁路被拒绝" };
  });
  const t = await startTestRuntime("snapshot-protected-tools", gate.responder, { config: { ...realTools(), execution: { backend: "native" } } });
  try {
    const rt = t.runtime;
    const roles = path.join(t.dirs.agentDir, "agents");
    fs.mkdirSync(roles, { recursive: true });
    fs.writeFileSync(path.join(roles, "guarded.md"), "---\ndescription: 检查来源保护\ntools: [read, write, request_file_access]\npermissions:\n  mode: confirm\n  protect_source: true\n---\n在副本处理资料。\n");
    source = fs.realpathSync(t.work[0]);
    fs.writeFileSync(path.join(source, "value.txt"), "base\n");
    initGitRepo(source);
    fs.writeFileSync(path.join(source, "value.txt"), "dirty\n");
    const index = fs.readFileSync(path.join(source, ".git/index"));
    const session = await rt.createSession({ projectName: "protected", cwd: source });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始 protected", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父任务运行", () => rt.store.getTask(parent.id)!.status === "running");
    delegated = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "guard", role: "guarded", target: ".", request: "检查写入边界", paramsDigest: "guard" });
    await waitFor("保护任务终态", () => ["completed", "failed", "interrupted"].includes(rt.store.getTask(delegated!.task.id)!.status));
    assert.equal(rt.store.getTask(delegated.task.id)!.status, "completed", rt.store.getTask(delegated.task.id)!.errorMessage ?? undefined);
    assert.equal(turn, 6);
    const ops = rt.store.listToolOpsByTask(delegated.task.id);
    assert.equal(fs.readFileSync(path.join(source, "value.txt"), "utf8"), "dirty\n");
    assert.deepEqual(fs.readFileSync(path.join(source, ".git/index")), index);
    assert.equal(ops.filter(op => op.toolName === "write" && op.isError).length, 3, JSON.stringify(ops.map(op => ({ name: op.toolName, error: op.isError, result: op.resultSummary }))));
    assert.equal(ops.filter(op => op.toolName === "request_file_access" && op.isError).length, 3);
    assert.equal(rt.store.listConfirmationsByTask(delegated.task.id).length, 0);
    assert.equal(fs.readFileSync(path.join(source, "value.txt"), "utf8"), "dirty\n");
    assert.deepEqual(fs.readFileSync(path.join(source, ".git/index")), index);
  } finally { gate.release(); await t.shutdown(); }
});

test("非 Git 受保护目标在准备副本或登记委派前拒绝，源目录保留", async () => {
  const gate = holdParentResponse(async () => ({ kind: "text", text: "结束" }));
  const t = await startTestRuntime("snapshot-protected-nongit", gate.responder, { config: { ...realTools(), execution: { backend: "native" } } });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "plain", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始 plain", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父任务运行", () => rt.store.getTask(parent.id)!.status === "running");
    await assert.rejects(rt.subagents!.delegate({ parentTaskId: parent.id, key: "nongit", role: "reviewer", target: ".", request: "审查当前代码", paramsDigest: "nongit" }), { code: "git_required" });
    assert.deepEqual(fs.readdirSync(session.cwdReal), []);
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 0);
    assert.ok(!rt.store.listTasksBySession(session.id).some(task => workCopyHostFor(task)));
  } finally { gate.release(); await t.shutdown(); }
});
