import { delegateFromActiveTask } from "./helpers/active-subagent-source.ts";
import { product as personalProduct } from "./helpers/legacy-product.ts";
/** 旧档案恢复补记唯一回报；非 IM 来源不外发。 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { afterTool, cleanupDirs, lastUserText, makeTestDirs, realTools, waitFor, writeModelsJson, type TestDirs } from "./helpers/testkit.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";

const OWNER = "880001";
const TG_TOKEN = "123456:FINAL-DELIVERY-TOKEN";
const TG_OWNER = 42;
const QQ_TIMEOUTS = { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 50, reconnectMaxMs: 150, sweepIntervalMs: 80 };

interface Harness {
  dirs: TestDirs;
  work: string[];
  onebot: MockOneBot;
  model: MockModelServer;
  api: FakeBotApi | null;
  apiBase: string | null;
  config: RuntimeConfig;
  close(): Promise<void>;
}

async function harness(prefix: string, responder: Responder, opts: { telegram?: boolean; workDirs?: number } = {}): Promise<Harness> {
  const { dirs, work } = await makeTestDirs(prefix, opts.workDirs ?? 0);
  const onebot = await startMockOneBot({});
  const model = new MockModelServer(responder);
  await writeModelsJson(dirs, await model.start());
  const api = opts.telegram ? new FakeBotApi({ token: TG_TOKEN, ownerId: TG_OWNER }) : null;
  const apiBase = api ? await api.start() : null;
  const config: RuntimeConfig = {
    product: personalProduct.runtime,
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model",
    ...realTools(),
    telegramDisabled: !api,
    telegram: api ? { pollTimeoutSec: 1, backoffMs: 50 } : undefined,
    qq: QQ_TIMEOUTS,
    scheduler: { tickMs: 30, sendTimeoutMs: 1_500 },
  };
  return {
    dirs, work, onebot, model, api, apiBase, config,
    async close() {
      await onebot.close();
      await model.close();
      await api?.close();
      await cleanupDirs(dirs);
    },
  };
}

async function configureQq(rt: Runtime, onebot: MockOneBot, owner: string | null = OWNER): Promise<void> {
  await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: owner });
  await rt.qqSetEnabled(true);
}

async function prepareQq(rt: Runtime, onebot: MockOneBot): Promise<void> {
  await rt.addCredentialBinding({ name: "qq-test", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await configureQq(rt, onebot);
  await waitFor("QQ 已核实登录账号在线", () => {
    const status = rt.qqStatus();
    return "actualSelfId" in status && status.online === true && status.actualSelfId === status.selfId;
  });
}

const mainSession = (rt: Runtime) => rt.store.getAgentRole("main")!.sessionId;
const allOps = (rt: Runtime) => rt.sched.listOps({ limit: 100 }).items;
const reportOps = (rt: Runtime) => allOps(rt).filter((op) => op.sourceKind === "owner_reply" && op.sourceKey.includes("#work:"));
const sends = (onebot: MockOneBot) => onebot.actions.filter((a) => a.action === "send_private_msg");
const sendTexts = (onebot: MockOneBot) => sends(onebot).map((a) => ((a.params.message as any[]).find((s) => s?.type === "text")?.data?.text ?? "") as string);
const push = (onebot: MockOneBot, messageId: number, text: string, userId = OWNER) =>
  onebot.pushPrivateMessage({ userId, messageId, segments: [{ type: "text", data: { text } }] });
const soleWork = (rt: Runtime) => {
  const works = rt.store.listWorkDelegations();
  assert.equal(works.length, 1, "应只有一项工作");
  return works[0]!;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** 标准委派流程响应器：子任务可挂起一次，唤醒回答固定，受理回复固定。 */
function delegateResponder(opts: { holdSub?: Promise<void>; extra?: (text: string, req: RecordedRequest) => any } = {}): Responder {
  let held = false;
  return async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (opts.holdSub && !held) {
        held = true;
        await opts.holdSub;
      }
      return { kind: "text", text: "SUB-RESULT 子任务结论" };
    }
    if (text.includes("[编排器]")) return { kind: "text", text: "FINAL-BODY 各子任务汇总" };
    const extra = opts.extra?.(text, req);
    if (extra) return extra;
    if (afterTool(req)) return { kind: "text", text: "ACCEPTED 已受理" };
    if (text.includes("DELEG")) {
      return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "调研要点", key: "r1", materials: [{ kind: "text", text: "材料 A" }] } }] };
    }
    return { kind: "text", text: "OK" };
  };
}

test("非 IM 来源零记录：TUI 与 dev 可委派，未授权外部来源拒绝", async () => {
  const h = await harness("fin-nonim", async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-RESULT" };
    if (text.includes("[编排器]")) return { kind: "text", text: "WAKE 汇总" };
    if (afterTool(req)) return { kind: "text", text: "已委派" };
    if (text.includes("TUI-DELEG")) {
      return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "界面调研", key: "t1", materials: [{ kind: "text", text: "材料 T" }] } }] };
    }
    if (text.includes("DEV-DELEG")) {
      return { kind: "tool_calls", calls: [{ id: "d2", name: "subagent_delegate", arguments: { request: "读一下", key: "v1", read_paths: ["."] } }] };
    }
    return { kind: "text", text: "OK" };
  }, { workDirs: 1 });
  const rt = await Runtime.start(h.config);
  try {
    // dev 会话：结果经下次模型调用注入，不建唤醒、不建发送
    const dev = await rt.createSession({ projectName: "fin-dev", cwd: h.work[0]! });
    await rt.submit({ sessionId: dev.id, requestId: "dev1", input: "DEV-DELEG", modelSelection: rt.defaultSelection });
    await waitFor("dev 工作完成", () => rt.store.listWorkDelegationsBySession(dev.id).length === 1 && rt.store.listTasksByWork(rt.store.listWorkDelegationsBySession(dev.id)[0]!.id).every((t) => t.status === "completed"), 30_000);

    // TUI 直提 main：main 链走通委派与唤醒，但发起任务没有来源事件
    await rt.submit({ sessionId: mainSession(rt), requestId: "tui1", input: "TUI-DELEG", modelSelection: rt.defaultSelection });
    await waitFor("TUI 工作的唤醒完成", () => {
      const work = rt.store.listWorkDelegationsBySession(mainSession(rt))[0];
      if (!work) return false;
      const execs = rt.store.listTasksByWork(work.id);
      const wake = execs.length === 1 ? rt.store.findTaskByRequest(mainSession(rt), `wake:${execs[0]!.id}`) : null;
      return execs.every((t) => t.status === "completed") && wake?.status === "completed";
    }, 30_000);

    const tuiChild = rt.store.listTasksByWork(rt.store.listWorkDelegationsBySession(mainSession(rt))[0]!.id)[0]!;
    const wakeInput = rt.store.findTaskByRequest(mainSession(rt), `wake:${tuiChild.id}`)!.input;
    assert.ok(!wakeInput.includes("[最终汇报]"), "非 IM 工作的唤醒输入不附汇报说明");

    // 其他外部来源不能把非拥有者事件当作委派授权。
    const { event: schedEvent } = await rt.orchestrator!.registerInboundEvent({ source: "internal", externalId: "fin-external-1", targetRole: "main", body: "定时触发" });
    await waitFor("外部任务完成", () => rt.store.getInboundEvent(schedEvent.id)?.status === "done", 30_000);
    const schedTask = rt.store.getTask(rt.store.getInboundEvent(schedEvent.id)!.taskId!)!;
    const workCount = rt.store.listWorkDelegations().length, agentCount = rt.store.listSubAgents().length;
    await assert.rejects(delegateFromActiveTask(rt, { parentTaskId: schedTask.id, key: "s1", request: "定时调研", readPaths: null, materials: [{ kind: "text", text: "材料 S" }], paramsDigest: "s1" }), { code: "source_forbidden" });
    assert.equal(rt.store.listWorkDelegations().length, workCount, "拒绝前不登记新工作");
    assert.equal(rt.store.listSubAgents().length, agentCount, "拒绝前不创建子代理");

    assert.equal(reportOps(rt).length, 0, "TUI/dev/其他外部来源不产生单项工作汇报记录");
    assert.equal(allOps(rt).length, 0, "也没有任何 owner_reply 发送");
    assert.equal(sends(h.onebot).length, 0);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("离线等待与恢复：pending 写等待原因，恢复后受理与汇报各发一次；重启补记幂等，再巡检仍一份", async () => {
  const subGate = deferred();
  const h = await harness("fin-offline", delegateResponder({ holdSub: subGate.promise }));
  let rt = await Runtime.start(h.config);
  try {
    await prepareQq(rt, h.onebot);
    push(h.onebot, 1, "MARK-DELEG 请调研");
    await waitFor("受理回复已送达", () => sendTexts(h.onebot).some((t) => t.includes("ACCEPTED")), 20_000);
    const wake = () => rt.store.findTaskByRequest(mainSession(rt), `wake:${rt.store.listTasksByWork(soleWork(rt).id)[0]!.id}`)!;

    // 平台离线后放行子任务：汇报登记但发不出去
    h.onebot.setOnline(false);
    h.onebot.pushHeartbeat({ online: false });
    await waitFor("QQ 离线", () => rt.qqStatus().online === false, 20_000);
    subGate.resolve();
    await waitFor("汇报已登记并记等待原因", () => reportOps(rt).length === 1 && reportOps(rt)[0]!.status === "pending" && reportOps(rt)[0]!.waitReason !== null, 30_000);
    assert.match(reportOps(rt)[0]!.waitReason!, /channel_offline/);
    const opId = reportOps(rt)[0]!.id;

    // 构造「唤醒结果落库前崩溃」窗口：结果与汇报登记一并丢失
    const wakeId = wake().id;
    await rt.stop("test_restart");
    const db = new Db(h.config.dataDir);
    db.prepare("UPDATE tasks SET result_summary = NULL, result_ref = NULL WHERE id = ?").run(wakeId);
    db.prepare("DELETE FROM notification_ops WHERE id = ?").run(opId);
    db.close();

    rt = await Runtime.start(h.config);
    await waitFor("巡检补记后仍只有一份汇报", () => reportOps(rt).length === 1, 30_000);
    assert.equal(reportOps(rt)[0]!.text, `[工作 ${soleWork(rt).id} 最终汇报]\nFINAL-BODY 各子任务汇总`, "补记按唤醒任务历史重取正文");

    // 再跑一轮（等价于第二次巡检）不发生变化
    await rt.stop("test_restart2");
    rt = await Runtime.start(h.config);
    await rt.scheduler!.tick();
    assert.equal(reportOps(rt).length, 1, "重复巡检不重复登记");

    h.onebot.setOnline(true);
    h.onebot.pushHeartbeat();
    await waitFor("QQ 恢复在线", () => {
      const status = rt.qqStatus();
      return "actualSelfId" in status && status.online === true;
    }, 20_000);
    await waitFor("恢复后汇报送达", () => reportOps(rt)[0]!.status === "sent", 20_000);
    assert.deepEqual(sendTexts(h.onebot), ["ACCEPTED 已受理", `[工作 ${soleWork(rt).id} 最终汇报]\nFINAL-BODY 各子任务汇总`], "受理与汇报各只发一次");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});
