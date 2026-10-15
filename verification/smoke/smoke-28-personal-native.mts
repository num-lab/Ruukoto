/** 个人 main 与独立定时根任务使用业务工具委派；worker、Git 与模式传播真实，模型及通知使用本地桩。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { product as personalProduct } from "../../apps/ruukoto/src/product.ts";
import { createLauncherFor } from "@ruukoto/agent/execution/launchers.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { GIT_SAFE_DIRECTORY_ENV } from "@ruukoto/core/worktree.ts";
import type { AccessMode } from "@ruukoto/core/types.ts";
import { firstDue, parseRule } from "@ruukoto/channels/scheduler/time.ts";
import { shellQuotePathForTest } from "../../test/helpers/git-fixture.ts";
import { lastUserText, realTools, startTestRuntime, waitFor, type TestRuntime } from "../../test/helpers/testkit.ts";
import type { Responder } from "../../test/helpers/mock-provider.ts";
import { assertUnitsStopped, cleanupRuntime, recordRuntimeUnits, requireNative, requireNoArgs } from "./gate.ts";

requireNoArgs();
if (process.platform !== "linux") {
  process.stderr.write("[ruukoto:smoke28] 前提缺失：个人产品真实委派验收需要 Linux；Coding Agent 的跨平台回归见 smoke26\n");
  process.exit(2);
}
await requireNative();
const target = { channel: "telegram", account: "1", chatId: "42", configVersion: 1 };
const clock = { now: Date.parse("2026-10-12T00:00:00Z") };
const reports: string[] = [];
const modes = ["confirm", "auto-review", "full_access"] satisfies readonly AccessMode[];
let releaseMain!: () => void, releaseCopies!: () => void;
const mainGate = new Promise<void>(resolve => { releaseMain = resolve; });
const copyGate = new Promise<void>(resolve => { releaseCopies = resolve; });
const copyReady = new Set<string>();
let sharedGit = "", forbidden = "";
let scheduledReady = false, releaseScheduled: () => void = () => {};
let scheduledGate: Promise<void> = Promise.resolve();
const responder: Responder = async req => {
  const text = lastUserText(req);
  const tools = req.messages.slice(req.messages.findLastIndex(message => message.role === "user") + 1).filter(message => message.role === "tool");
  const done = tools.length;
  if (text.includes("[SubAgent 委派") && text.includes("COPY-")) {
    const name = text.includes("COPY-A") ? "A" : "B";
    if (done === 1) { copyReady.add(name); await copyGate; }
    const file = name.toLowerCase() + ".txt";
    const calls = [
      { id: name + "-read", name: "read", arguments: { path: file } },
      { id: name + "-edit", name: "edit", arguments: { path: file, edits: [{ oldText: name, newText: name + "-fixed" }] } },
      { id: name + "-write", name: "write", arguments: { path: name + "-result.txt", content: name + "-done\n" } },
      { id: name + "-bash", name: "bash", arguments: { command: `set -eu; git -c core.fsmonitor=false status --porcelain; git -c core.fsmonitor=false diff; node -e 'if(process.getuid()!==${process.getuid?.()}||process.env.DBUS_SESSION_BUS_ADDRESS||process.env.RUUKOTO_CONTROL_DIR)process.exit(1)'` } },
      { id: name + "-git-denied", name: "bash", arguments: { command: `printf denied >> ${shellQuotePathForTest(path.join(sharedGit, "config"))}` } },
    ];
    return done < calls.length ? { kind: "tool_calls", calls: [calls[done]] } : { kind: "text", text: name + "-complete" };
  }
  if (text.includes("[SubAgent 委派")) {
    if (done === 1) { scheduledReady = true; await scheduledGate; }
    const workId = /工作 (\S+)（/.exec(text)![1];
    const calls = [
      { id: "material-read", name: "read", arguments: { path: /资料：本目录 (materials-\S+\.txt)/.exec(text)![1] } },
      { id: "sibling-denied", name: "read", arguments: { path: forbidden } },
      { id: "progress", name: "subagent_message", arguments: { work_id: workId, key: "progress", text: "PROGRESS-NATIVE" } },
    ];
    return done < calls.length ? { kind: "tool_calls", calls: [calls[done]] } : { kind: "text", text: "CHILD-NATIVE-DONE" };
  }
  if (text.includes("MAIN-COPIES")) {
    assert.ok(req.tools?.every(tool => !["read", "edit", "write", "bash"].includes((tool.function as { name: string }).name)), "main 根任务不获得编码工具");
    if (done < 2) {
      const name = done === 0 ? "A" : "B";
      return { kind: "tool_calls", calls: [{ id: "delegate-" + name, name: "subagent_delegate", arguments: {
        key: name, request: "COPY-" + name, target: "repo",
      } }] };
    }
    await mainGate;
    return { kind: "text", text: "MAIN-COPIES-DONE" };
  }
  if (text.includes("SCHEDULE-DELEGATE")) {
    assert.ok(req.tools?.every(tool => !["read", "edit", "write", "bash"].includes((tool.function as { name: string }).name)), "定时根任务不获得编码工具");
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "schedule-child", name: "subagent_delegate", arguments: {
      key: "child", request: "READ-SCHEDULE", materials: [{ kind: "text", text: "EXPLICIT-SCHEDULE-MATERIAL" }],
    } }] };
    return { kind: "text", text: "ROOT-ACK" };
  }
  if (text.startsWith("[编排器]")) return { kind: "text", text: "RUN-FINAL" };
  return { kind: "text", text: "MAIN-RESPONDED" };
};

let t: TestRuntime | null = null;
let bootstrap: ToolWorkerHost | null = null, bootstrapStopped = true;
let units: ReturnType<typeof recordRuntimeUnits> = [];
let failure: unknown = null;
try {
  t = await startTestRuntime("personal28", responder, { workDirs: 0, config: {
    product: personalProduct.runtime, ...realTools(), execution: { backend: "native" }, qqDisabled: true, telegramDisabled: true,
    scheduler: { now: () => clock.now, tickMs: 0, channel: { target: () => target,
      send: async input => { reports.push(input.text); return { platformMessageId: "sent-" + reports.length }; } } },
  } });
  const runtime = t.runtime;
  units = recordRuntimeUnits(runtime);
  assert.equal(runtime.executionInfo().backend, "native");
  const main = runtime.store.getAgentRole("main")!;
  const repo = path.join(main.workDir, "repo");
  fs.mkdirSync(repo);
  for (const name of ["A", "B"]) fs.writeFileSync(path.join(repo, name.toLowerCase() + ".txt"), name + "\n");
  forbidden = path.join(main.workDir, "private-fixture.txt");
  fs.writeFileSync(forbidden, "PRIVATE-MAIN-FIXTURE\n");
  const identity = fs.statSync(repo);
  bootstrap = ToolWorkerHost.create(createLauncherFor({ backend: "native", native: { protectedRoots: runtime.protectedRoots() } }, "confirm"), {
    taskId: "personal28-init", mode: "confirm", workspace: repo, workspaceIdentity: { dev: identity.dev, ino: identity.ino },
    grantedPaths: [], env: GIT_SAFE_DIRECTORY_ENV,
  });
  bootstrapStopped = false;
  await bootstrap.start();
  const initialized = await bootstrap.call({ opId: "init", sdkCallId: "init", name: "bash", params: {
    command: "set -eu; git init -q; git config user.email smoke@example.com; git config user.name smoke; git add -A; git commit -q -m init", timeout: 30,
  } });
  assert.equal(initialized.isError, false);
  bootstrapStopped = await bootstrap.stop();
  assert.equal(bootstrapStopped, true);

  const parent = await runtime.submit({ sessionId: main.sessionId, requestId: "main-copies", input: "MAIN-COPIES", modelSelection: runtime.defaultSelection });
  await waitFor("main 委派两份并行副本", () => copyReady.size === 2, 90_000);
  const works = runtime.store.listWorkDelegationsBySession(main.sessionId);
  assert.equal(works.length, 2);
  const copies = works.map(work => {
    const write = work.writeTarget;
    assert.ok(write?.kind === "worktree");
    const task = runtime.store.listTasksByWork(work.id).find(item => item.subAgentId)!;
    return { work, write, task };
  });
  sharedGit = copies[0].write.commonGitDir;
  const gitConfig = fs.readFileSync(path.join(sharedGit, "config"), "utf8");
  assert.notEqual(copies[0].write.path, copies[1].write.path);
  assert.notEqual(copies[0].write.branch, copies[1].write.branch);
  releaseCopies();
  for (const copy of copies) {
    await waitFor("副本四工具完成", () => runtime.store.getTask(copy.task.id)?.status === "completed", 90_000);
    const ops = runtime.store.listToolOpsByTask(copy.task.id);
    for (const name of ["read", "edit", "write", "bash"]) assert.equal(ops.find(op => op.toolName === name && !op.sdkCallId?.endsWith("-git-denied"))?.isError, false);
    assert.equal(ops.find(op => op.sdkCallId?.endsWith("-git-denied"))?.isError, true);
    await assertUnitsStopped(units, copy.task.id);
    const integrated = await runtime.subagents!.integrate({ workId: copy.work.id, parentTaskId: parent.id, parentSessionId: main.sessionId });
    assert.equal(integrated.state, "applied");
    assert.ok(fs.existsSync(copy.write.path), "汇总保留副本");
  }
  assert.equal(fs.readFileSync(path.join(sharedGit, "config"), "utf8"), gitConfig);
  for (const name of ["A", "B"]) {
    assert.equal(fs.readFileSync(path.join(repo, name.toLowerCase() + ".txt"), "utf8"), name + "-fixed\n");
    assert.equal(fs.readFileSync(path.join(repo, name + "-result.txt"), "utf8"), name + "-done\n");
  }
  releaseMain();
  await waitFor("main 根任务收尾", () => runtime.store.getTask(parent.id)?.status === "completed");
  process.stderr.write("[ruukoto:smoke28] PASS main 双 worktree、四工具、共享 Git 拒写及汇总\n");

  for (const mode of modes) {
    scheduledReady = false;
    scheduledGate = new Promise<void>(resolve => { releaseScheduled = resolve; });
    const due = new Date(clock.now + 1000).toISOString();
    const rule = parseRule({ kind: "once", at: due, time_zone: "UTC" });
    const plan = runtime.store.withTx(() => runtime.sched.insertSchedule({
      createKey: mode, paramsDigest: mode, createTaskId: null, createOpId: null, projectId: main.projectId,
      createPermissionVersion: 1, accessMode: mode, rule, instruction: "SCHEDULE-DELEGATE", sourceRefs: [], target,
      nextDueAt: firstDue(rule, clock.now), tzData: "smoke", reason: "验证登记模式",
    }, "smoke"));
    clock.now += 1000;
    await runtime.scheduler!.tick();
    const run = runtime.sched.listRuns(plan.id, 1)[0]!;
    assert.notEqual(run.sessionId, main.sessionId);
    assert.equal(runtime.store.getSessionIdentity(run.sessionId!)?.kind, "scheduled");
    await waitFor("定时子任务已完成真实读取并等待后续", () => scheduledReady, 90_000);
    const chat = await runtime.submit({ sessionId: main.sessionId, requestId: "chat-" + mode, input: "MAIN-CHAT", modelSelection: runtime.defaultSelection });
    await waitFor("子任务执行期间主聊天仍可响应", () => runtime.store.getTask(chat.id)?.status === "completed");
    assert.equal(runtime.sched.getRun(run.id)?.closedAt, null, "子任务未收尾不提前关闭运行");
    releaseScheduled();
    await waitFor("定时子任务及汇总完成", () => runtime.store.listScheduledRunTasks(run.id).some(task => task.requestId.startsWith("wake:") && task.resultSummary !== null), 90_000);
    const tasks = runtime.store.listScheduledRunTasks(run.id);
    assert.ok(tasks.every(task => task.accessMode === mode), "实际登记模式传播给全部派生任务");
    const child = tasks.find(task => task.subAgentId)!;
    const operations = runtime.store.listToolOpsByTask(child.id);
    const materialRead = operations.find(op => op.sdkCallId === "material-read");
    assert.equal(materialRead?.toolName, "read");
    assert.equal(materialRead?.isError, false);
    assert.match(materialRead?.resultSummary ?? "", /EXPLICIT-SCHEDULE-MATERIAL/);
    assert.equal(operations.find(op => op.sdkCallId === "sibling-denied")?.isError, true, "限定资料不能读取 main 私有兄弟文件");
    await assertUnitsStopped(units, child.id);
    const recorded = units.filter(unit => unit.taskId === child.id);
    assert.ok(recorded.every(unit => unit.unit.entry.kind === (mode === "full_access" ? "process_group" : "systemd_unit")));
    runtime.scheduler!.closeFinished();
    await runtime.scheduler!.tick();
    await runtime.scheduler!.idle();
    assert.equal(runtime.sched.getRun(run.id)?.resultStatus, "completed");
    assert.equal(reports.length, modes.indexOf(mode) + 1);
    await runtime.scheduler!.tick();
    await runtime.scheduler!.idle();
    assert.equal(reports.length, modes.indexOf(mode) + 1, "重复收尾只通知一次");
    process.stderr.write(`[ruukoto:smoke28] PASS 独立定时 ${mode} 委派、工作内消息、模式及一次汇总\n`);
  }
  assert.equal(runtime.store.listAllOccupancy().length, 0);
} catch (error) { failure = error; }
finally {
  releaseMain(); releaseCopies(); releaseScheduled();
  if (bootstrap && !bootstrapStopped) bootstrapStopped = await bootstrap.stop();
  if (t) {
    t.client.close();
    const runtime = t.runtime;
    const cleanup = await cleanupRuntime({ stop: async reason => {
      await runtime.stop(reason);
      if (!bootstrapStopped) throw new Error("初始化单元停止未核实");
    } }, t.server, t.dirs.root, units);
    failure ??= cleanup;
  }
  if (!bootstrapStopped) failure = new Error("初始化 worker 停止未核实；保留本次临时资料");
}
if (failure) {
  process.stderr.write(`[ruukoto:smoke28] FAIL ${String(failure)}\n`);
  process.exitCode = 1;
} else process.stderr.write("[ruukoto:smoke28] 全部通过；模型与通知使用桩，Linux worker 与 Git 操作真实\n");
