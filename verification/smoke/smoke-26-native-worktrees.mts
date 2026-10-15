/** 模型打桩；Runtime、控制面、原生 worker、Git 副本与汇总均真实执行。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { product as codingProduct } from "../../apps/ruukoto-code/src/product.ts";
import { createLauncherFor, ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { GIT_SAFE_DIRECTORY_ENV } from "@ruukoto/core/worktree.ts";
import type { Task, WorkWriteTarget } from "@ruukoto/core/types.ts";
import { holdParentResponse } from "../../test/helpers/active-parent.ts";
import { shellQuotePathForTest } from "../../test/helpers/git-fixture.ts";
import { lastUserText, realTools, startTestRuntime, waitFor, type TestRuntime } from "../../test/helpers/testkit.ts";
import type { Responder } from "../../test/helpers/mock-provider.ts";

if (process.argv.length > 2) {
  process.stderr.write("[ruukoto:smoke26] 此入口不接受参数；请在已构建的检出目录运行\n");
  process.exit(2);
}

const checks: Array<{ name: string; status: "pass" | "fail" | "unavailable"; detail?: string }> = [];
async function check(name: string, action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
    checks.push({ name, status: "pass" });
    process.stderr.write(`[ruukoto:smoke26] PASS ${name}\n`);
  } catch (error) {
    const unavailable = error instanceof ExecutionError && error.code === "execution_unavailable";
    checks.push({ name, status: unavailable ? "unavailable" : "fail", detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

let repo = "", commonGit = "";
let releaseCopies!: () => void;
const copiesGate = new Promise<void>((resolve) => { releaseCopies = resolve; });
const enteredCopies = new Set<string>();
const response: Responder = async (request) => {
  const text = lastUserText(request);
  const done = request.messages.filter((message) => message.role === "tool").length;
  if (text.includes("FLOW-fix")) {
    const calls = [
      { id: "fix-read", name: "read", arguments: { path: "sum.mjs" } },
      { id: "fix-before", name: "bash", arguments: { command: "node check.mjs" } },
      { id: "fix-edit", name: "edit", arguments: { path: "sum.mjs", edits: [{ oldText: "let total = 1;", newText: "let total = 0;" }] } },
      { id: "fix-write", name: "write", arguments: { path: "report.txt", content: "native-fixed\n" } },
      { id: "fix-after", name: "bash", arguments: { command: "node check.mjs" } },
    ];
    return done < calls.length ? { kind: "tool_calls", calls: [calls[done]] } : { kind: "text", text: "修复与检查完成" };
  }
  if (text.includes("FLOW-read")) {
    const calls = [
      { id: "read-allowed", name: "read", arguments: { path: path.join(repo, "a.txt") } },
      { id: "read-denied", name: "read", arguments: { path: path.join(repo, "b.txt") } },
    ];
    return done < calls.length ? { kind: "tool_calls", calls: [calls[done]] } : { kind: "text", text: "限定范围读取完成" };
  }
  for (const name of ["A", "B"]) {
    if (!text.includes("FLOW-copy-" + name)) continue;
    if (done === 0) { enteredCopies.add(name); await copiesGate; }
    const file = name === "A" ? "a.txt" : "b.txt", old = name === "A" ? "alpha" : "beta";
    const calls = [
      { id: name + "-read", name: "read", arguments: { path: file } },
      { id: name + "-edit", name: "edit", arguments: { path: file, edits: [{ oldText: old, newText: old + "-" + name }] } },
      { id: name + "-write", name: "write", arguments: { path: "copy-" + name + ".txt", content: name + "-only\n" } },
      { id: name + "-git", name: "bash", arguments: { command: "set -eu; git -c core.fsmonitor=false status --porcelain; git -c core.fsmonitor=false diff; git -c core.fsmonitor=false log --format=%s -1" } },
      { id: name + "-git-denied", name: "bash", arguments: { command: `printf forbidden >> ${shellQuotePathForTest(path.join(commonGit, "config"))}` } },
    ];
    return done < calls.length ? { kind: "tool_calls", calls: [calls[done]] } : { kind: "text", text: name + " 副本完成" };
  }
  return { kind: "text", text: "父任务完成" };
};

const parentGate = holdParentResponse(response);
let testRuntime: TestRuntime | null = null;
let bootstrap: ToolWorkerHost | null = null;
let cleanupSafe = false, bootstrapStopped = true, exitCode = 0;
try {
  testRuntime = await startTestRuntime("native26", parentGate.responder, {
    workDirs: 1, config: { product: codingProduct.runtime, ...realTools(), execution: { backend: "native" } },
  });
  const { runtime, client } = testRuntime;
  repo = fs.realpathSync(testRuntime.work[0]);
  fs.writeFileSync(path.join(repo, "sum.mjs"), "export function sum(xs) { let total = 1; for (const x of xs) total += x; return total; }\n");
  fs.writeFileSync(path.join(repo, "check.mjs"), "import {sum} from './sum.mjs'; if(sum([1,2,3])!==6) process.exit(1); process.stdout.write('check-ok\\n');\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "beta\n");
  const repoIdentity = fs.statSync(repo);
  const initHost = bootstrap = ToolWorkerHost.create(createLauncherFor({ backend: "native", native: { protectedRoots: runtime.protectedRoots() } }, "confirm"), {
    taskId: "smoke26-bootstrap", mode: "confirm", workspace: repo,
    workspaceIdentity: { dev: repoIdentity.dev, ino: repoIdentity.ino }, grantedPaths: [], env: GIT_SAFE_DIRECTORY_ENV,
  });
  await check("Git 夹具由原生 worker 初始化", async () => {
    assert.equal(runtime.executionInfo().backend, "native");
    bootstrapStopped = false;
    try {
      await initHost.start();
      const result = await initHost.call({ opId: "init", sdkCallId: "init", name: "bash", params: {
        command: "set -eu; git init -q; git config user.email smoke@example.com; git config user.name smoke; git add -A; git commit -q -m init", timeout: 30,
      }, timeoutMs: 45_000 });
      assert.equal(result.isError, false);
      assert.ok(fs.existsSync(path.join(repo, ".git", "HEAD")));
    } finally { bootstrapStopped = await initHost.stop(); }
    assert.equal(bootstrapStopped, true, "初始化单元停止须核实");
  });

  await check("控制面提交真实 read/edit/write/bash，修复前检查失败、修复后通过", async () => {
    const session = await runtime.createSession({ projectName: "native-fix", cwd: repo });
    const task = await client.request<Task>("submit", { session_id: session.id, request_id: "fix", input: "FLOW-fix", model_selection: runtime.defaultSelection });
    await waitFor("修复任务收尾", () => ["completed", "failed", "interrupted"].includes(runtime.store.getTask(task.id)!.status), 90_000);
    assert.equal(runtime.store.getTask(task.id)!.status, "completed");
    const operations = runtime.store.listToolOpsByTask(task.id);
    for (const id of ["fix-read", "fix-edit", "fix-write", "fix-after"]) assert.equal(operations.find(op => op.sdkCallId === id)?.isError, false, id);
    assert.equal(operations.find(op => op.sdkCallId === "fix-before")?.isError, true);
    assert.match(fs.readFileSync(path.join(repo, "sum.mjs"), "utf8"), /let total = 0;/);
    assert.equal(fs.readFileSync(path.join(repo, "report.txt"), "utf8"), "native-fixed\n");
  });

  const parentSession = await runtime.createSession({ projectName: "native-parent", cwd: repo });
  const parent = await client.request<Task>("submit", { session_id: parentSession.id, request_id: "parent", input: "开始原生委派", model_selection: runtime.defaultSelection });
  await waitFor("父任务持有占用", () => runtime.store.getTask(parent.id)?.status === "running" && runtime.store.getOccupancyByDir(repo)?.taskId === parent.id);
  await check("只读 SubAgent 真实读取限定文件，未授予的兄弟文件被拒绝", async () => {
    const read = await runtime.subagents!.delegate({ parentTaskId: parent.id, key: "read", request: "FLOW-read", readPaths: ["a.txt"], materials: null, paramsDigest: "read" });
    await waitFor("只读子任务收尾", () => runtime.store.getTask(read.task.id)?.status === "completed", 90_000);
    const operations = runtime.store.listToolOpsByTask(read.task.id);
    assert.equal(operations.find(op => op.sdkCallId === "read-allowed")?.isError, false);
    assert.equal(operations.find(op => op.sdkCallId === "read-denied")?.isError, true);
  });

  const copies: Array<{ target: Extract<WorkWriteTarget, { kind: "worktree" }>; workId: string; taskId: string; name: string }> = [];
  await check("活动父任务在原生边界内创建两个独立 worktree，并行运行", async () => {
    for (const name of ["A", "B"]) {
      const delegated = await runtime.subagents!.delegate({ parentTaskId: parent.id, key: name, request: "FLOW-copy-" + name,
        target: ".", readPaths: null, materials: null, paramsDigest: name });
      const target = delegated.work.writeTarget!;
      assert.ok(target.kind === "worktree");
      copies.push({ target, workId: delegated.work.id, taskId: delegated.task.id, name });
      commonGit = target.commonGitDir;
    }
    await waitFor("两个副本模型调用均在途", () => enteredCopies.size === 2, 90_000);
    assert.equal(runtime.store.getTask(copies[0].taskId)?.status, "running");
    assert.equal(runtime.store.getTask(copies[1].taskId)?.status, "running");
    assert.notEqual(copies[0].target.path, copies[1].target.path);
    assert.notEqual(copies[0].target.branch, copies[1].target.branch);
  });
  const originalConfig = fs.readFileSync(path.join(commonGit, "config"), "utf8");
  releaseCopies();
  await check("两个副本真实修改与 Git 只读操作成功，共享 Git 写入拒绝", async () => {
    for (const copy of copies) {
      await waitFor(copy.name + " 副本任务收尾", () => runtime.store.getTask(copy.taskId)?.status === "completed", 90_000);
      const operations = runtime.store.listToolOpsByTask(copy.taskId);
      for (const suffix of ["read", "edit", "write", "git"]) assert.equal(operations.find(op => op.sdkCallId === copy.name + "-" + suffix)?.isError, false);
      assert.equal(operations.find(op => op.sdkCallId === copy.name + "-git-denied")?.isError, true);
    }
    assert.equal(fs.readFileSync(path.join(commonGit, "config"), "utf8"), originalConfig);
  });
  await check("副本间成果独立，父工作区未提交修复与原字节没有进入副本", () => {
    for (const copy of copies) {
      const sibling = copy.name === "A" ? "B" : "A";
      assert.equal(fs.readFileSync(path.join(copy.target.path, "copy-" + copy.name + ".txt"), "utf8"), copy.name + "-only\n");
      assert.equal(fs.existsSync(path.join(copy.target.path, "copy-" + sibling + ".txt")), false);
      assert.match(fs.readFileSync(path.join(copy.target.path, "sum.mjs"), "utf8"), /let total = 1;/);
      assert.equal(fs.existsSync(path.join(copy.target.path, "report.txt")), false);
    }
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "alpha\n");
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "beta\n");
  });
  await check("原生临时 worker 汇总两个副本，父未提交成果与副本保留", async () => {
    const beforeHead = fs.readFileSync(path.join(commonGit, "refs", "heads", fs.readFileSync(path.join(commonGit, "HEAD"), "utf8").trim().replace("ref: refs/heads/", "")), "utf8");
    for (const copy of copies) {
      const result = await runtime.subagents!.integrate({ workId: copy.workId, parentTaskId: parent.id, parentSessionId: parentSession.id });
      assert.equal(result.state, "applied");
      assert.ok(fs.existsSync(copy.target.path));
    }
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "alpha-A\n");
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "beta-B\n");
    assert.match(fs.readFileSync(path.join(repo, "sum.mjs"), "utf8"), /let total = 0;/);
    assert.equal(fs.readFileSync(path.join(repo, "report.txt"), "utf8"), "native-fixed\n");
    const afterHead = fs.readFileSync(path.join(commonGit, "refs", "heads", fs.readFileSync(path.join(commonGit, "HEAD"), "utf8").trim().replace("ref: refs/heads/", "")), "utf8");
    assert.equal(afterHead, beforeHead);
    assert.equal(runtime.store.getEventsAfter(0, 1000).filter(event => event.body.type === "work_delegation.integrated").length, 2);
  });
  await check("父任务收尾后所有执行占用释放", async () => {
    parentGate.release();
    await waitFor("父任务收尾", () => runtime.store.getTask(parent.id)?.status === "completed", 90_000);
    await waitFor("全部目录占用释放", () => runtime.store.listAllOccupancy().length === 0, 15_000);
    cleanupSafe = true;
  });
} catch (error) {
  exitCode = error instanceof ExecutionError && error.code === "execution_unavailable" ? 2 : 1;
  process.stderr.write(`[ruukoto:smoke26] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  if (error instanceof ExecutionError && error.unit) {
    for await (const chunk of error.unit.stderr) process.stderr.write(`[ruukoto:smoke26] 原生入口 stderr：${String(chunk)}\n`);
  }
} finally {
  parentGate.release(); releaseCopies();
  if (bootstrap && !bootstrapStopped) bootstrapStopped = await bootstrap.stop();
  if (testRuntime) {
    testRuntime.client.close();
    try { await testRuntime.runtime.stop("smoke26_end"); }
    catch (error) { exitCode = 1; cleanupSafe = false; process.stderr.write(`[ruukoto:smoke26] 清理未核实：${String(error)}\n`); }
    try { await testRuntime.server.close(); }
    catch (error) { exitCode = 1; cleanupSafe = false; process.stderr.write(`[ruukoto:smoke26] 模型桩关闭失败：${String(error)}\n`); }
    if (cleanupSafe && bootstrapStopped) {
      try { fs.rmSync(testRuntime.dirs.root, { recursive: true, force: true }); }
      catch (error) { exitCode = 1; cleanupSafe = false; process.stderr.write(`[ruukoto:smoke26] 资料清理失败：${String(error)}\n`); }
    }
    if (!cleanupSafe || !bootstrapStopped) process.stderr.write(`[ruukoto:smoke26] 保留现场：${testRuntime.dirs.root}\n`);
  }
}
process.stderr.write(`[ruukoto:smoke26] ${JSON.stringify({ platform: process.platform, arch: process.arch, exitCode, cleanupVerified: cleanupSafe && bootstrapStopped,
  pass: checks.filter(item => item.status === "pass").length, fail: checks.filter(item => item.status === "fail").length,
  unavailable: 8 - checks.length + checks.filter(item => item.status === "unavailable").length, checks })}\n`);
process.exitCode = exitCode;
