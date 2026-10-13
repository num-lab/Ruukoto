import { product as personalProduct } from "../../apps/ruukoto/src/product.ts";
/**
 * 同项工作内 SubAgent 相互通信（agent-direction issue 13）的本机冒烟。
 *
 * 模拟：模型（MockModelServer 确定性脚本）与消息平台（不启用）。
 * 真实：Runtime + 控制面 + SQLite 库 + 独立 JSONL + 真实受限工具工作进程
 * （native 原生后端）+ 真实文件读取与
 * 只读范围 + 真实 CLI（apps/ruukoto/bin/ruukoto.mjs work show，经 socket 与拥有者令牌）。
 *
 * 覆盖（与工单验收对应）：
 *  S1. 协作加入：B 经 work_id + sub_agent_id 拉入既有工作 W，执行记录独立；
 *  S2. 双向消息与来源：A→B 经工具、B→A 经工具，投递为真实受限 worker 下的
 *      本工作任务，任务输入带宿主来源首行，消息行/事件带来源可追溯；
 *  S3. 上级通道：主 Agent → A 的补充投递为本工作任务；B → 主 Agent 的消息
 *      经 dev 下一次拥有者任务的宿主 [工作内消息] 参考块送达；
 *  S4. 重复投递不重复：同键管理器重放与冲刷重入只有一条消息行、一个投递
 *      任务、一个 sent 事件；投递任务无残余执行单元；
 *  S5. 复用后资格转移与关闭明确结果：B 复用于新工作后 W 内消息明确被拒；
 *      关闭后消息报「已关闭、消息未投递」且不含「新建」；
 *  S6. 真实 CLI `work show` 可读消息列表（来源与投递状态）；重启后消息
 *      记录保留、冲刷不重放（事件/任务数不变）。
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
import { waitFor, lastUserText, realTools, connectAuthedClient, writeModelsJson } from "../../test/helpers/testkit.ts";
import { MockModelServer, type Responder } from "../../test/helpers/mock-provider.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";

import { assertUnitsStopped, cleanupRuntime, recordRuntimeUnits, requireNative, requireNoArgs } from "./gate.ts";

requireNoArgs();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true, detail: "" });
      process.stderr.write("[ruukoto:smoke13] " + `PASS ${name}` + "\n");
    })
    .catch((err) => {
      results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
      process.stderr.write("[ruukoto:smoke13] " + `FAIL ${name}: ${(err as Error).message}` + "\n");
    });
}

await requireNative();
process.stderr.write("[ruukoto:smoke13] " + `环境：${process.platform} ${process.arch}；执行 native` + "\n");

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "ruukoto-smoke13-")));
const workDir = path.join(root, "workspace");
fs.mkdirSync(workDir, { recursive: true });
const fileA = path.join(workDir, "a.txt");
const fileB = path.join(workDir, "b.txt");
fs.writeFileSync(fileA, "资料 A\n", "utf8");
fs.writeFileSync(fileB, "资料 B\n", "utf8");

let aId = "";
let bId = "";
let wId = "";
const marker = "SMOKE13-W2-TASK";
let releaseParent: () => void = () => {};
let parentGate: Promise<void> = Promise.resolve();

const responder: Responder = async (req) => {
  const text = lastUserText(req);
  if (text === "SMOKE13-PARENT") { await parentGate; return { kind: "text", text: "主轮收尾" }; }
  const roundTools = req.messages.slice(req.messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "tool");
  if ((text.includes("[SubAgent 委派") || text.includes("[工作内消息")) && !roundTools.some(m => m.tool_call_id === "native-read")) {
    const selected = text.includes("独立任务B") || text.includes("加入协作") || text.includes("A问B") || text.includes(marker) || text.includes("汇报主Agent") ? fileB : fileA;
    return { kind: "tool_calls", calls: [{ id: "native-read", name: "read", arguments: { path: selected } }] };
  }
  if (text.includes("[SubAgent 委派")) {
    if (text.includes("汇报主Agent")) {
      if (roundTools.some(message => message.tool_call_id === "report-parent")) return { kind: "text", text: "已汇报主Agent" };
      return { kind: "tool_calls", calls: [{ id: "report-parent", name: "subagent_message", arguments: { work_id: wId, key: "sk6", text: "汇报主Agent SMOKE13-REPORT" } }] };
    }
    if (text.includes("联络B")) {
      if (roundTools.some(m => m.tool_call_id === "m1")) return { kind: "text", text: "SMOKE13-SUB-A-TOLD-B" };
      return {
        kind: "tool_calls",
        calls: [{ id: "m1", name: "subagent_message", arguments: { work_id: wId, key: "m1", text: "A问B：结论一致吗 SMOKE13-MSG-A2B", to_sub_agent_id: bId } }],
      };
    }
    if (text.includes("独立任务B")) return { kind: "text", text: "SMOKE13-SUB-B-DONE" };
    return { kind: "text", text: "SMOKE13-SUB-DONE" };
  }
  if (text.includes("[工作内消息")) {
    if (text.includes("A问B")) {
      if (roundTools.some(m => m.tool_call_id === "r1")) return { kind: "text", text: "SMOKE13-SUB-B-REPLIED" };
      return {
        kind: "tool_calls",
        calls: [{ id: "r1", name: "subagent_message", arguments: { work_id: wId, key: "r1", text: "B答A：一致 SMOKE13-MSG-B2A", to_sub_agent_id: aId } }],
      };
    }
    if (text.includes("补充给A")) return { kind: "text", text: "SMOKE13-SUB-A-GOT-SUP" };
    return { kind: "text", text: "SMOKE13-SUB-A-GOT-REPLY" };
  }
  if (text.includes(marker)) return { kind: "text", text: "SMOKE13-SUB-W2-DONE" };
  return { kind: "text", text: "收到" };
};

// ============ ruukoto：真实原生 worker worker + 真实 CLI ============
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
  thinkingLevel: "off",
  modelProvider: "mock",
  modelId: "mock-model",
  product: personalProduct.runtime,
  ...realTools(),
  execution: { backend: "native" },
};

const evidence: string[] = [];
const deliveryTaskIds: string[] = [];
let rt = await Runtime.start(config);
const units = recordRuntimeUnits(rt);
await ControlServer.start(rt);
try {
  const session = await rt.createSession({ projectName: "smoke13", cwd: workDir });
  const activeParent = async (requestId: string) => {
    parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    const task = await rt.submit({ sessionId: session.id, requestId, input: "SMOKE13-PARENT", modelSelection: rt.defaultSelection });
    await waitFor("管理操作的实际父任务正在运行", () => rt.store.getTask(task.id)?.status === "running");
    return task;
  };
  let parent = await activeParent("p1");

  const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk1", request: "调研A", readPaths: [fileA], paramsDigest: "d-sk1" });
  aId = a.agent.id;
  wId = a.work.id;
  await waitFor("A 完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null, 60_000);
  await waitForIdle(aId);
  const b = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk2", request: "独立任务B", readPaths: [fileB], paramsDigest: "d-sk2" });
  bId = b.agent.id;
  await waitFor("B 完成", () => rt.store.getTask(b.task.id)!.resultSummary !== null, 60_000);
  await waitForIdle(bId);

  async function waitForIdle(id: string): Promise<void> {
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(id)!.state === "idle");
  }
  function messageTasks(sessionId: string): any[] {
    return rt.store.listTasksBySession(sessionId).filter((t: any) => t.requestId.startsWith("smsg:"));
  }
  function sentEvents(): any[] {
    return (rt.store.db.prepare("SELECT body FROM events").all() as Array<{ body: string }>)
      .map((r) => JSON.parse(r.body))
      .filter((x) => x.type === "subagent_message.sent");
  }

  await check("S1 协作加入：B 拉入既有工作，执行记录独立", async () => {
    const join = await rt.subagents!.delegate({
      parentTaskId: parent.id,
      key: "sk3",
      request: "加入协作",
      workId: wId,
      subAgentId: bId,
      readPaths: [fileB],
      paramsDigest: "d-sk3",
    });
    assert.equal(join.created, true);
    assert.equal(join.newWork, false);
    assert.equal(join.task.subAgentId, bId);
    assert.match(join.task.input, /协作方/);
    assert.equal(rt.store.getSubAgent(bId)!.activeWorkId, wId);
    await waitFor("加入完成", () => rt.store.getTask(join.task.id)!.resultSummary !== null, 60_000);
    await waitForIdle(bId);
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 2, "无新工作行");
    evidence.push(`协作加入：工作 ${wId} 的执行含 A（首次）与 B（加入）`);
  });

  await check("S2 双向消息与来源：A→B、B→A 投递为本工作任务，来源可追溯", async () => {
    const cont = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk4", request: "联络B", workId: wId, readPaths: [fileA], paramsDigest: "d-sk4" });
    await waitFor("A 联络完成", () => rt.store.getTask(cont.task.id)!.resultSummary !== null, 60_000);
    await waitForIdle(aId);
    const bDelivery = messageTasks(rt.store.getSubAgent(bId)!.sessionId);
    assert.equal(bDelivery.length, 1, "A→B 一个投递任务");
    assert.match(bDelivery[0]!.input, /\[工作内消息 · 工作 .*\]/);
    assert.match(bDelivery[0]!.input, new RegExp(`来自：SubAgent ${aId}（工作 ${wId}，执行任务 ${cont.task.id}）`));
    assert.match(bDelivery[0]!.input, /SMOKE13-MSG-A2B/);
    deliveryTaskIds.push(bDelivery[0]!.id);
    await waitFor("B 投递完成", () => rt.store.getTask(bDelivery[0]!.id)!.resultSummary !== null, 60_000);
    await waitForIdle(bId);
    const aDelivery = messageTasks(rt.store.getSubAgent(aId)!.sessionId);
    assert.equal(aDelivery.length, 1, "B→A 一个投递任务");
    assert.match(aDelivery[0]!.input, new RegExp(`来自：SubAgent ${bId}`));
    assert.match(aDelivery[0]!.input, /SMOKE13-MSG-B2A/);
    deliveryTaskIds.push(aDelivery[0]!.id);
    await waitFor("A 投递完成", () => rt.store.getTask(aDelivery[0]!.id)!.resultSummary !== null, 60_000);
    await waitForIdle(aId);
    const msgs = rt.store.listSubAgentMessagesByWork(wId);
    assert.equal(msgs.length, 2);
    assert.deepEqual(
      msgs.map((m: any) => [m.fromSubAgentId, m.toSubAgentId]),
      [
        [aId, bId],
        [bId, aId],
      ],
    );
    assert.ok(msgs.every((m: any) => m.deliveredTaskId !== null && m.undeliveredReason === null));
    evidence.push(`消息 ${msgs[0]!.id}（A→B，任务 ${msgs[0]!.deliveredTaskId}）、${msgs[1]!.id}（B→A，任务 ${msgs[1]!.deliveredTaskId}）`);
  });

  await check("S3 上级通道：主 Agent 补充投递为本工作任务；SubAgent→主 Agent 经 dev 注入送达", async () => {
    const sup = await rt.subagents!.message({ senderTaskId: parent.id, workId: wId, key: "sk5", text: "补充给A SMOKE13-SUP", toSubAgentId: aId, paramsDigest: "d-sk5" });
    assert.equal(sup.delivery, "task");
    const aDelivery = messageTasks(rt.store.getSubAgent(aId)!.sessionId).at(-1)!;
    assert.match(aDelivery.input, new RegExp(`来自：主 Agent（父会话任务 ${parent.id}）`));
    assert.match(aDelivery.input, /SMOKE13-SUP/);
    deliveryTaskIds.push(aDelivery.id);
    await waitFor("补充完成", () => rt.store.getTask(aDelivery.id)!.resultSummary !== null, 60_000);
    await waitForIdle(aId);
    // B → 主 Agent：dev 注入通道（下一次拥有者任务的宿主参考块）
    const report = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "report-parent", request: "汇报主Agent", workId: wId, subAgentId: bId, readPaths: [fileB], paramsDigest: "report-parent" });
    await waitFor("B 经真实工具汇报主Agent", () => rt.store.getTask(report.task.id)?.resultSummary !== null, 60_000);
    await waitForIdle(bId);
    const toParent = rt.store.listSubAgentMessagesByWork(wId).find(message => message.requestKey === "sk6")!;
    assert.ok(toParent && toParent.toSubAgentId === null);
    releaseParent();
    await waitFor("首轮父任务收尾", () => rt.store.getTask(parent.id)?.status === "completed");
    const owner2 = await rt.submit({ sessionId: session.id, requestId: "p2", input: "下一步", modelSelection: rt.defaultSelection });
    await waitFor("第二轮完成", () => rt.store.getTask(owner2.id)!.status === "completed", 60_000);
    const call = server.calls.map((c) => c).find((c) => {
      const all = c.messages
        .map((m: any) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((x: any) => x?.text ?? "").join("") : ""))
        .join("\n");
      return all.includes("[工作内消息]") && all.includes("SMOKE13-REPORT");
    });
    assert.ok(call, "dev 注入参考块含消息与正文");
    assert.ok(rt.store.getSubAgentMessage(toParent.id)!.deliveredAt !== null, "注入已标记送达");
    evidence.push(`主 Agent 补充 → 任务 ${aDelivery.id}；SubAgent→主 Agent 注入消息 ${toParent.id}`);
  });

  parent = await activeParent("p3");

  await check("S4 重复投递不重复：同键重放与冲刷重入；无残余执行单元", async () => {
    const before = {
      msgs: rt.store.listSubAgentMessagesByWork(wId).length,
      events: sentEvents().length,
      tasks: rt.store.listTasksBySession(rt.store.getSubAgent(aId)!.sessionId).length,
    };
    // 同键管理器重放：返回原记录
    const replay = await rt.subagents!.message({ senderTaskId: parent.id, workId: wId, key: "sk5", text: "补充给A SMOKE13-SUP", toSubAgentId: aId, paramsDigest: "d-sk5" });
    assert.equal(replay.created, false);
    // 冲刷重入：不重复投递、不重复事件
    await rt.subagents!.flushPendingMessages(session.id);
    await rt.subagents!.flushPendingMessages(session.id);
    assert.equal(rt.store.listSubAgentMessagesByWork(wId).length, before.msgs, "消息行不变");
    assert.equal(sentEvents().length, before.events, "sent 事件不变");
    assert.equal(rt.store.listTasksBySession(rt.store.getSubAgent(aId)!.sessionId).length, before.tasks, "任务数不变");
    for (const taskId of deliveryTaskIds) {
      await assertUnitsStopped(units, taskId);
    }
  });

  await check("S5 复用后资格转移与关闭明确结果", async () => {
    const w2 = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk7", request: marker, subAgentId: bId, readPaths: [fileB], paramsDigest: "d-sk7" });
    await waitFor("新工作完成", () => rt.store.getTask(w2.task.id)!.resultSummary !== null, 60_000);
    await waitForIdle(bId);
    assert.equal(rt.store.getSubAgent(bId)!.activeWorkId, w2.work.id);
    await assert.rejects(
      () => rt.subagents!.message({ senderTaskId: parent.id, workId: wId, key: "sk8", text: "x", toSubAgentId: bId, paramsDigest: "d-sk8" }),
      /当前工作不是本工作/,
      "复用后旧工作协作方失去资格",
    );
    rt.subagents!.close({ subAgentId: bId, by: "owner" });
    try {
      await rt.subagents!.message({ senderTaskId: parent.id, workId: w2.work.id, key: "sk9", text: "x", toSubAgentId: bId, paramsDigest: "d-sk9" });
      assert.fail("应拒绝");
    } catch (err) {
      assert.match((err as Error).message, /已关闭/);
      assert.match((err as Error).message, /消息未投递/);
      assert.ok(!(err as Error).message.includes("新建"), "不把关闭当作重建理由");
    }
    evidence.push(`B 复用 ${w2.work.id} 后旧消息被拒；关闭后投递报已关闭（关闭方 owner）`);
  });

  releaseParent();
  await waitFor("管理父轮收尾", () => rt.store.getTask(parent.id)?.status === "completed");

  await check("S6 真实 CLI work show 读消息列表；重启后记录保留、冲刷不重放", async () => {
    for (const agentId of [aId, bId]) {
      const agent = rt.store.getSubAgent(agentId)!;
      for (const task of rt.store.listTasksBySession(agent.sessionId)) {
        const read = rt.store.listToolOpsByTask(task.id).find(op => op.sdkCallId === "native-read");
        assert.equal(read?.isError, false, `执行任务 ${task.id} 须真正读到钉定资料`);
        assert.match(read?.resultSummary ?? "", /资料 [AB]/);
        await assertUnitsStopped(units, task.id);
      }
    }
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, RUUKOTO_DATA_DIR: dataDir,
      RUUKOTO_AGENT_DIR: agentDir, RUUKOTO_CONTROL_DIR: rt.controlDir() };
    const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, "apps", "ruukoto", "bin", "ruukoto.mjs"), "work", "show", wId], { encoding: "utf8", env, timeout: 60_000 });
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.messages) && parsed.messages.length === 4, `work show 消息数：${parsed.messages?.length}`);
    assert.ok(parsed.messages.some((m: any) => m.fromSubAgentId === aId && m.toSubAgentId === bId && m.deliveredTaskId));
    evidence.push(`CLI work show：messages ${parsed.messages.length} 条（含 A→B 已投递）`);
    const beforeEvents = sentEvents().length;
    const beforeTasksA = rt.store.listTasksBySession(rt.store.getSubAgent(aId)!.sessionId).length;
    await rt.stop("smoke_restart");
    rt = await Runtime.start(config);
  recordRuntimeUnits(rt, units);
    await ControlServer.start(rt);
    // 启动冲刷：全部已送达/被拒，不重放任何事件或任务
    assert.equal(rt.store.listSubAgentMessagesByWork(wId).length, 4, "消息记录跨重启保留");
    assert.equal(sentEvents().length, beforeEvents, "重启冲刷不重复事件");
    assert.equal(rt.store.listTasksBySession(rt.store.getSubAgent(aId)!.sessionId).length, beforeTasksA, "重启冲刷不重复任务");
  });
} finally {
  releaseParent();
  const failure = await cleanupRuntime(rt, server, root, units);
  if (failure) results.push({ name: "清理本次资源", ok: false, detail: `${failure.message}；保留现场 ${root}；${String(failure.cause)}` });
}

// ---------- 汇总 ----------
process.stderr.write("[ruukoto:smoke13] " + "\n===== 证据 =====" + "\n");
for (const line of evidence) process.stderr.write("[ruukoto:smoke13] " + line + "\n");
const failed = results.filter((r) => !r.ok);
process.stderr.write("[ruukoto:smoke13] " + `\n${results.length - failed.length}/${results.length} PASS${failed.length ? `，${failed.length} FAIL` : ""}` + "\n");
process.exit(failed.length ? 1 : 0);
