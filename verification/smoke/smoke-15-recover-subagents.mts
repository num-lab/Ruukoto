import { product as codingProduct } from "../../apps/ruukoto-code/src/product.ts";
/**
 * 后台重启后恢复 SubAgent 与工作记录（agent-direction issue 15）的本机冒烟。
 *
 * 模拟：模型（MockModelServer 确定性脚本）与消息平台（不启用）；「异常崩溃」
 * 的持久形态按 86 同法置位（优雅 stop 会把 running 定 backend_stop 并回收
 * 占用，所以在 stop 与重新 Runtime.start 之间用新连接把种子任务置为
 * running 并种下遗留占用——恢复的判定输入与真实崩溃后的库内容一致）。
 * 真实：Runtime + 控制面 + SQLite 库 + 独立 JSONL + 真实受限工具工作进程
 * （native 原生后端）+ 真实 CLI
 * （apps/ruukoto-code/bin/ruukoto-code.mjs resume-queue，经 socket 与拥有者令牌）。
 *
 * 覆盖（与工单验收对应）：
 *  B1. 重启时排队的委派任务定 interrupted（backend_restart）：不自动继续
 *      （零模型请求、零 worker）、结果归属保持、Agent 回 idle；dev 父会话下一轮
 *      注入该结果；沿 work_id 继续委派真实原生 worker完成；
 *  B2. 遗留占用（无法确认旧执行已退出）：保留占用与 occupancy_unverified
 *      暂停、Agent 记 unverified 且拒绝新委派；真实 CLI resume-queue 释放
 *      占用、解除暂停、Agent 回 idle，可继续委派；
 *  B3. 宿主固定评审的排队任务（带来源事件）不中断：子会话的
 *      backend_restart 暂停由编排器启动恢复自动解除并继续执行；
 *  B4. 重复重启不重复登记：结果与事件不增、不自动运行；空闲期间无残余执行单元。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL；2 = 原生能力不可用。
 * TMPDIR 可换位置。原生前置见 deploy/native/README.md。
 *
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { waitFor, lastUserText, realTools, writeModelsJson } from "../../test/helpers/testkit.ts";
import { MockModelServer, type Responder, type RecordedRequest } from "../../test/helpers/mock-provider.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { subAgentTaskRequestId } from "@ruukoto/agent/subagent-ledger.ts";

import { assertUnitsStopped, cleanupRuntime, recordRuntimeUnits, requireNative, requireNoArgs } from "./gate.ts";

requireNoArgs();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true, detail: "" });
      process.stderr.write("[ruukoto:smoke15] " + `PASS ${name}` + "\n");
    })
    .catch((err) => {
      results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
      process.stderr.write("[ruukoto:smoke15] " + `FAIL ${name}: ${(err as Error).message}` + "\n");
    });
}

await requireNative();
process.stderr.write("[ruukoto:smoke15] " + `环境：${process.platform} ${process.arch}；执行 native` + "\n");

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "ruukoto-smoke15-")));
const workDir = path.join(root, "workspace");
fs.mkdirSync(workDir, { recursive: true });
const fileA = path.join(workDir, "a.txt");
const secretA = `RECOVER-A-${Math.random().toString(36).slice(2, 10)}`;
fs.writeFileSync(fileA, `资料 A ${secretA}\n`, "utf8");

function afterTool(req: RecordedRequest): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
}
function inputText(req: RecordedRequest): string {
  return req.messages
    .map((m: any) => {
      const content = m?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
      return "";
    })
    .join("\n");
}
function eventsOf(rt: Runtime, type: string): any[] {
  const rows = rt.store.db.prepare("SELECT body FROM events").all() as Array<{ body: string }>;
  return rows.map((r) => JSON.parse(r.body)).filter((b) => b.type === type);
}

const evidence: string[] = [];
let workA = "";
let nextRoundText = "";
let releaseB2!: () => void;
const b2Gate = new Promise<void>(resolve => { releaseB2 = resolve; });

const responder: Responder = async (req) => {
  const text = lastUserText(req);
  if (text === "B2-HOLD") { await b2Gate; return { kind: "text", text: "B2父轮完成" }; }
  if (text.includes("[SubAgent 委派")) {
    if (text.includes("评审任务SMOKE15-R")) return { kind: "text", text: "SMOKE15-R-评审结论" };
    if (text.includes("继续分析 A") && afterTool(req)) return { kind: "text", text: "SMOKE15-CONT-继续结论" };
    if (afterTool(req)) return { kind: "text", text: `SMOKE15-A-结论 ${secretA}` };
    return { kind: "tool_calls", calls: [{ id: "r1", name: "read", arguments: { path: fileA } }] };
  }
  if (text.includes("dev下一轮")) {
    nextRoundText = inputText(req);
    return { kind: "text", text: "收到" };
  }
  if (afterTool(req)) return { kind: "text", text: "已继续" };
  if (text.includes("继续 A")) return { kind: "tool_calls", calls: [{ id: "d2", name: "subagent_delegate", arguments: { request: "继续分析 A", key: "cont1", work_id: workA, read_paths: [fileA] } }] };
  if (text.includes("委派 A")) return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "分析工作 A", key: "rc1", read_paths: [fileA] } }] };
  return { kind: "text", text: "收到" };
};

// ============ ruukoto-code：真实原生 worker worker + 真实 CLI ============
const server = new MockModelServer(responder);
const baseUrl = await server.start();
const dataDir = path.join(root, "data");
const agentDir = path.join(root, "agent");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
await writeModelsJson({ root, dataDir, agentDir }, baseUrl);
const config: RuntimeConfig = {
  dataDir,
  agentDir,
  // 不配 socketPath：默认 <root>/control/control.sock，与真实 CLI 的发现路径一致
  thinkingLevel: "off",
  modelProvider: "mock",
  modelId: "mock-model",
  product: codingProduct.runtime,
  ...realTools(),
  execution: { backend: "native" },
};

let rt = await Runtime.start(config);
const units = recordRuntimeUnits(rt);
await ControlServer.start(rt);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, RUUKOTO_CODE_DATA_DIR: dataDir,
  RUUKOTO_CODE_AGENT_DIR: agentDir, RUUKOTO_CODE_CONTROL_DIR: rt.controlDir() };

/** 播种子会话的排队任务；先按 backend_restart 暂停会话（崩溃遗留形态），避免循环提前取走。 */
function seedQueued(sessionId: string, workId: string, subAgentId: string, parentTaskId: string, key: string, input: string, sourceEventId: string | null = null) {
  rt.store.setSessionQueueState(sessionId, "paused", "backend_restart");
  return rt.store.withTx(() =>
    rt.store.insertQueuedTask({
      sessionId,
      requestId: subAgentTaskRequestId(workId, key),
      input,
      accessMode: "confirm",
      modelSelection: rt.defaultSelection,
      submissionDigest: `smoke15-${key}`,
      parentTaskId,
      workId,
      subAgentId,
      sourceEventId,
    }).task,
  );
}

async function restart() {
  await rt.stop("smoke_restart");
  rt = await Runtime.start(config);
  recordRuntimeUnits(rt, units);
  await ControlServer.start(rt);
}

try {
  const session = await rt.createSession({ projectName: "smoke15", cwd: workDir });
  const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "委派 A", modelSelection: rt.defaultSelection });
  await waitFor("父任务完成（已委派 A）", () => rt.store.getTask(parent.id)!.status === "completed");
  workA = rt.store.listWorkDelegationsBySession(session.id)[0]!.id;
  const agent = rt.store.getSubAgent(rt.store.getWorkDelegation(workA)!.subAgentId)!;
  const taskA1 = rt.store.listTasksByWork(workA)[0]!.id;
  await waitFor("A 首次执行完成", () => rt.store.getTask(taskA1)!.status === "completed", 60_000);
  await waitFor("Agent 空闲", () => rt.store.getSubAgent(agent.id)!.state === "idle");
  const firstRead = rt.store.listToolOpsByTask(taskA1).find(op => op.sdkCallId === "r1");
  assert.equal(firstRead?.isError, false);
  assert.match(firstRead?.resultSummary ?? "", new RegExp(secretA));
  evidence.push(`workA ${workA}，SubAgent ${agent.id}（子会话 ${agent.sessionId}），首次执行任务 ${taskA1}（真实原生 worker read）`);

  // ---------- B1：排队委派任务的重启恢复 ----------
  const q1 = seedQueued(agent.sessionId, workA, agent.id, parent.id, "b1-queued", "排队任务SMOKE15-Q1");
  await restart();
  await check("B1 排队委派任务定 interrupted、不自动继续、Agent 回 idle、结果归属保持", async () => {
    const after = rt.store.getTask(q1.id)!;
    assert.equal(after.status, "interrupted");
    assert.equal(after.interruptReason, "backend_restart");
    assert.equal(after.startedAt, null, "排队任务从未启动");
    assert.ok(after.resultSummary !== null, "巡检补记一次结果");
    const ref = JSON.parse(after.resultRef!);
    assert.equal(ref.workId, workA);
    assert.equal(ref.subAgentId, agent.id);
    assert.equal(ref.parentSessionId, session.id);
    assert.equal(ref.parentTaskId, parent.id);
    assert.equal(ref.outcome, "unknown");
    assert.equal(server.calls.filter((c) => inputText(c).includes("SMOKE15-Q1")).length, 0, "零模型请求，不自动继续");
    assert.equal(eventsOf(rt, "subagent_task.result_unknown").filter((e) => e.taskId === q1.id).length, 1);
    assert.equal(units.filter(unit => unit.taskId === q1.id).length, 0, "排队任务没有 worker");
    const a = rt.store.getSubAgent(agent.id)!;
    assert.equal(a.state, "idle", "Agent 回到可用");
    assert.equal(rt.store.getSession(agent.sessionId)!.queueState, "active");
    evidence.push(`B1：Q1 ${q1.id} interrupted(backend_restart)，结果引用归属 work/subAgent/父会话/父任务，零模型请求零 worker`);
  });

  await check("B1 dev 父会话下一轮模型调用注入中断结果", async () => {
    const next = await rt.submit({ sessionId: session.id, requestId: "p2", input: "dev下一轮", modelSelection: rt.defaultSelection });
    await waitFor("dev 下一轮完成", () => rt.store.getTask(next.id)!.status === "completed");
    assert.ok(nextRoundText.includes("- 工作 ") && nextRoundText.includes(workA), "中断结果注入下一轮上下文");
    assert.ok(nextRoundText.includes("结果未知") || nextRoundText.includes("中断"), "注入内容标明中断");
  });

  await check("B1 空闲 Agent 沿 work_id 继续委派（真实原生 worker完成）", async () => {
    const parent2 = await rt.submit({ sessionId: session.id, requestId: "p3", input: "继续 A", modelSelection: rt.defaultSelection });
    await waitFor("继续轮父任务完成", () => rt.store.getTask(parent2.id)!.status === "completed", 60_000);
    const cont = rt.store.listTasksByWork(workA).find((t) => t.requestId.endsWith(":cont1"))!;
    await waitFor("继续任务完成", () => rt.store.getTask(cont.id)!.status === "completed", 60_000);
    assert.ok(rt.store.getTask(cont.id)!.resultSummary!.includes("SMOKE15-CONT"), "继续委派真实完成");
    const continuedRead = rt.store.listToolOpsByTask(cont.id).find(op => op.sdkCallId === "r1");
    assert.equal(continuedRead?.isError, false);
    assert.match(continuedRead?.resultSummary ?? "", new RegExp(secretA));
    await waitFor("Agent 再空闲", () => rt.store.getSubAgent(agent.id)!.state === "idle");
  });

  // ---------- B2：遗留占用与 unverified 出口 ----------
  const selection = rt.defaultSelection;
  await rt.stop("smoke_restart");
  // 崩溃前的持久形态：活动会话内一条 running 任务持有占用（优雅 stop 会把
  // running 定 backend_stop 并回收占用，故在两个实例之间用新连接一次性播种：
  // 排队任务落库后立刻置 running、种下占用与 Agent 状态）
  const q2id: string = (() => {
    const db = new Db(dataDir);
    const store = new Store(db);
    try {
      const { task } = store.withTx(() =>
        store.insertQueuedTask({
          sessionId: agent.sessionId,
          requestId: subAgentTaskRequestId(workA, "b2-running"),
          input: "运行中任务SMOKE15-R1",
          accessMode: "confirm",
          modelSelection: selection,
          submissionDigest: "smoke15-b2-running",
          parentTaskId: parent.id,
          workId: workA,
          subAgentId: agent.id,
        }),
      );
      store.db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), task.id);
      const real = fs.realpathSync(agent.workDir);
      const stat = fs.statSync(real);
      assert.ok(store.withTx(() => store.tryAcquireOccupancy({ cwdReal: real, cwdDev: stat.dev, cwdIno: stat.ino, sessionId: agent.sessionId, taskId: task.id })));
      store.setSubAgentState(agent.id, "running", { activeWorkId: workA, currentTaskId: task.id });
      return task.id;
    } finally {
      db.close();
    }
  })();
  rt = await Runtime.start(config);
  recordRuntimeUnits(rt, units);
  await ControlServer.start(rt);
  const q2 = { id: q2id };
  const b2Parent = await rt.submit({ sessionId: session.id, requestId: "b2-owner", input: "B2-HOLD", modelSelection: rt.defaultSelection });
  await waitFor("B2管理父轮实际运行", () => rt.store.getTask(b2Parent.id)?.status === "running");
  await check("B2 遗留占用保留、暂停不解除、Agent 记 unverified、拒绝新委派", async () => {
    const after = rt.store.getTask(q2.id)!;
    assert.equal(after.status, "interrupted");
    assert.equal(after.interruptReason, "backend_restart");
    assert.equal(rt.store.listAllOccupancy().filter((o) => o.sessionId === agent.sessionId).length, 1, "遗留占用保留");
    const childSession = rt.store.getSession(agent.sessionId)!;
    assert.equal(childSession.queueState, "paused");
    assert.equal(childSession.queuePauseReason, "occupancy_unverified", "启动恢复不解除未核实的暂停");
    assert.equal(rt.store.getSubAgent(agent.id)!.state, "unverified");
    await assert.rejects(
      () => rt.subagents!.delegate({ parentTaskId: b2Parent.id, key: "b2-x", request: "拒绝", workId: workA, readPaths: [fileA], materials: null, paramsDigest: "smoke15-b2-x" }),
      /待核实|正忙/,
      "未核实前拒绝新委派",
    );
    assert.equal(server.calls.filter((c) => inputText(c).includes("SMOKE15-R1")).length, 0, "旧执行不并发重跑");
  });
  await check("B2 真实 CLI resume-queue：释放占用、解除暂停、Agent 回 idle", async () => {
    const { stdout: out } = await execFileAsync(process.execPath, [path.join(repoRoot, "apps", "ruukoto-code", "bin", "ruukoto-code.mjs"), "resume-queue", agent.sessionId], { encoding: "utf8", env, timeout: 60_000 });
    assert.match(out, /"queueState": "active"/, out);
    assert.equal(rt.store.listAllOccupancy().filter((o) => o.sessionId === agent.sessionId).length, 0, "占用释放");
    assert.equal(rt.store.getSession(agent.sessionId)!.queueState, "active");
    assert.equal(rt.store.getSubAgent(agent.id)!.state, "idle", "unverified 的唯一出口");
    evidence.push(`B2：Q2 ${q2.id} 遗留占用经 CLI resume-queue 释放，Agent unverified → idle`);
  });
  await check("B2 回 idle 后可继续委派（真实原生 worker完成）", async () => {
    const d3 = await rt.subagents!.delegate({ parentTaskId: b2Parent.id, key: "b2-cont", request: "继续分析 A", workId: workA, readPaths: [fileA], materials: null, paramsDigest: "smoke15-b2-cont" });
    assert.equal(d3.created, true);
    await waitFor("B2 继续任务完成", () => rt.store.getTask(d3.task.id)!.status === "completed", 60_000);
    const recoveredRead = rt.store.listToolOpsByTask(d3.task.id).find(op => op.sdkCallId === "r1");
    assert.equal(recoveredRead?.isError, false);
    assert.match(recoveredRead?.resultSummary ?? "", new RegExp(secretA));
  });

  releaseB2();
  await waitFor("B2父轮收尾", () => rt.store.getTask(b2Parent.id)?.status === "completed");

  // ---------- B3：宿主固定评审排队任务自动恢复 ----------
  const review = seedQueued(agent.sessionId, workA, agent.id, parent.id, "b3-review", "评审任务SMOKE15-R", "evt_smoke15_review");
  await restart();
  await check("B3 带来源事件的评审排队任务不中断，自动恢复并继续执行", async () => {
    await waitFor("评审任务完成", () => rt.store.getTask(review.id)!.status === "completed", 60_000);
    assert.equal(rt.store.getSession(agent.sessionId)!.queueState, "active", "启动恢复自动解除 backend_restart 暂停");
    assert.equal(server.calls.filter((c) => inputText(c).includes("SMOKE15-R")).length, 1, "评审任务继续执行且只执行一次");
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(agent.id)!.state === "idle");
    evidence.push(`B3：评审任务 ${review.id}（source_event_id 钉版）自动恢复并真实完成`);
  });

  // ---------- B4：重复重启幂等 ----------
  const unknownBefore = eventsOf(rt, "subagent_task.result_unknown").length;
  const resultsBefore = new Map(rt.store.listTasksByWork(workA).map((t) => [t.id, rt.store.getTask(t.id)!.resultSummary]));
  await restart();
  await check("B4 重复重启不重复登记、不自动运行、无残余执行单元", async () => {
    assert.equal(eventsOf(rt, "subagent_task.result_unknown").length, unknownBefore, "result_unknown 事件不增");
    for (const [id, summary] of resultsBefore) {
      assert.equal(rt.store.getTask(id)!.resultSummary, summary, `任务 ${id} 结果不被改写`);
    }
    assert.equal(rt.store.getSession(agent.sessionId)!.queueState, "active");
    const callsBefore = server.calls.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(server.calls.length, callsBefore, "重启后旧任务不产生新模型调用");
    for (const taskId of [q1.id, q2.id, review.id]) {
      await assertUnitsStopped(units, taskId, false);
    }
  });
} finally {
  releaseB2();
  const failure = await cleanupRuntime(rt, server, root, units);
  if (failure) {
    const detail = `${failure.message}；保留现场 ${root}；${String(failure.cause)}`;
    results.push({ name: "清理本次资源", ok: false, detail });
    process.stderr.write("[ruukoto:smoke15] " + `FAIL 清理本次资源：${detail}` + "\n");
  }
}

// ---------- 汇总 ----------
process.stderr.write("[ruukoto:smoke15] " + "\n===== 证据 =====" + "\n");
for (const line of evidence) process.stderr.write("[ruukoto:smoke15] " + line + "\n");
const failed = results.filter((r) => !r.ok);
process.stderr.write("[ruukoto:smoke15] " + `\n${results.length - failed.length}/${results.length} PASS${failed.length ? `，${failed.length} FAIL` : ""}` + "\n");
process.exit(failed.length ? 1 : 0);
