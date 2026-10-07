/**
 * 异步工作最终结果送回原 IM 入口（agent-direction issue 18）。
 *
 * seam：真实 Runtime + mock 模型 + MockOneBot / FakeBotApi（不接触真实 QQ/Telegram）。
 * - 先受理、可续聊、后汇报：工作收尾的唯一汇报经 owner_reply 槽发回发起入口，
 *   引用原入站消息；渠道内受理在前、汇报在后；taskId 为收尾唤醒任务；
 * - 汇报目标与正文按工作发起链钉版：不从会话最新回答或其他入口推断；
 * - 并发/重启/重复终态只产生一份汇报（同键幂等）；补充原工作再收尾产生新的一份；
 * - 离线等待、目标变化不改发、结果不明不重发、限流按 not_before 再发同一记录；
 * - 授权不扩大：未收尾唤醒不外发、唤醒轮次 notification_enqueue 仍需审批、
 *   调度/dev 来源零记录、工具清单无新增。
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "../src/core/db.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { cleanupDirs, lastUserText, makeTestDirs, realTools, waitFor, writeModelsJson, type TestDirs } from "./helpers/testkit.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";

const OWNER = "880001";
const OTHER = "880002";
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

async function prepareTelegram(rt: Runtime, apiBase: string): Promise<void> {
  await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
  await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: String(TG_OWNER) });
  await rt.telegramSetEnabled(true);
  await waitFor("Telegram 轮询在线", () => rt.telegramStatus().online === true);
}

const mainSession = (rt: Runtime) => rt.store.getAgentRole("main")!.sessionId;
const allOps = (rt: Runtime) => rt.sched.listOps({ limit: 100 }).items;
const reportOps = (rt: Runtime) => allOps(rt).filter((op) => op.sourceKind === "owner_reply" && op.sourceKey.includes("#work:"));
const sends = (onebot: MockOneBot) => onebot.actions.filter((a) => a.action === "send_private_msg");
const sendTexts = (onebot: MockOneBot) => sends(onebot).map((a) => ((a.params.message as any[]).find((s) => s?.type === "text")?.data?.text ?? "") as string);
const sendReplyIds = (onebot: MockOneBot) => sends(onebot).map((a) => (a.params.message as any[]).find((s) => s?.type === "reply")?.data?.id ?? null);
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

function toolNamesOf(call: RecordedRequest): string[] {
  return (call.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter((n: unknown): n is string => typeof n === "string");
}
const afterTool = (req: RecordedRequest): boolean => req.messages[req.messages.length - 1]?.role === "tool";
/** 请求中所有消息的文本串联（宿主模板输入识别）。 */
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

test("QQ：先受理、可续聊、收尾后唯一最终汇报引用原消息；重复终态与工具清单回归", async () => {
  const subGate = deferred();
  const h = await harness("fin-qq", delegateResponder({
    holdSub: subGate.promise,
    extra: (text) => (text.includes("MARK-SECOND") ? { kind: "text", text: "SECOND-ANSWER 第二条答复" } : null),
  }));
  const rt = await Runtime.start(h.config);
  try {
    await prepareQq(rt, h.onebot);
    push(h.onebot, 1, "MARK-DELEG 请调研");
    await waitFor("受理回复已送达", () => sendTexts(h.onebot).some((t) => t.includes("ACCEPTED")), 20_000);
    push(h.onebot, 2, "MARK-SECOND 子任务还在跑，先回我这条");
    await waitFor("第二条消息已回复（委派不阻塞会话）", () => sendTexts(h.onebot).some((t) => t.includes("SECOND-ANSWER")), 20_000);
    subGate.resolve();
    await waitFor("最终汇报已送达", () => reportOps(rt).some((op) => op.status === "sent"), 30_000);

    const work = soleWork(rt);
    const child = rt.store.listTasksByWork(work.id)[0]!;
    const main = mainSession(rt);
    const wake = rt.store.findTaskByRequest(main, `wake:${child.id}`)!;
    assert.equal(wake.status, "completed");
    assert.match(wake.input, /\[最终汇报\]/, "唤醒输入告知 main 收尾汇报规则");
    assert.ok(wake.input.includes(work.id));

    // 渠道内顺序：受理 → 第二条答复 → 最终汇报（按 created_at 领取）
    assert.deepEqual(sendTexts(h.onebot), ["ACCEPTED 已受理", "SECOND-ANSWER 第二条答复", `[工作 ${work.id} 最终汇报]\nFINAL-BODY 各子任务汇总`]);
    // 汇报与原消息引用（受理引用 msg 1、其他引用各自原消息）
    assert.deepEqual(sendReplyIds(h.onebot), ["1", "2", "1"], "汇报引用工作发起时的原入站消息");

    const ops = reportOps(rt);
    assert.equal(ops.length, 1, "一次收尾只有一份汇报");
    const op = ops[0]!;
    const origin = rt.store.getTask(work.originTaskId)!;
    const event = rt.store.getInboundEvent(origin.sourceEventId!)!;
    assert.equal(op.sourceKey, `${event.id}#work:${work.id}:${child.id}`, "发送键 = 发起事件 + 工作 + 收尾执行任务");
    assert.equal(op.taskId, wake.id, "发送记录的 taskId 为收尾唤醒任务");
    assert.deepEqual(op.target, event.replyTarget, "目标 = 发起事件钉版目标");
    assert.equal(op.status, "sent");
    assert.equal(op.text, `[工作 ${work.id} 最终汇报]\nFINAL-BODY 各子任务汇总`);
    const events = (rt.store.db.prepare("SELECT body FROM events").all() as Array<{ body: string }>).map((r) => JSON.parse(r.body));
    assert.equal(events.filter((e) => e.type === "qq_private.reply_skipped").length, 0);

    // 重复的终态回传不产生第二份（handleTerminal 一次写入 + insertOp 同键幂等）
    rt.orchestrator!.onRuntimeEvents([{ seq: 0, taskId: wake.id, sessionId: main, body: { type: "task.completed", taskId: wake.id, sessionId: main }, createdAt: new Date().toISOString() }]);
    await rt.scheduler!.tick();
    assert.equal(reportOps(rt).length, 1);
    assert.equal(sendTexts(h.onebot).filter((t) => t.includes("最终汇报")).length, 1);

    // 工具清单无新增（本轮无 report/work_report 一类工具）
    const wakeReq = h.model.calls.find((c) => inputText(c).includes("[编排器]"))!;
    assert.ok(!toolNamesOf(wakeReq).some((n) => /report/i.test(n)), "没有为汇报新增任何工具");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("Telegram：受理在前汇报在后，汇报引用原入站消息", async () => {
  const subGate = deferred();
  const h = await harness("fin-tg", delegateResponder({
    holdSub: subGate.promise,
    extra: (text) => (text.includes("MARK-SECOND") ? { kind: "text", text: "SECOND-ANSWER 第二条答复" } : null),
  }), { telegram: true });
  const rt = await Runtime.start(h.config);
  const api = h.api!;
  try {
    await prepareTelegram(rt, h.apiBase!);
    const m1 = api.push({ text: "MARK-DELEG 请调研", from: TG_OWNER });
    await waitFor("受理回复已送达", () => api.sends.some((s) => s.text.includes("ACCEPTED")), 20_000);
    const m2 = api.push({ text: "MARK-SECOND 继续", from: TG_OWNER });
    await waitFor("第二条已回复", () => api.sends.length === 2, 20_000);
    subGate.resolve();
    await waitFor("最终汇报已送达", () => api.sends.some((s) => s.text.includes("最终汇报")), 30_000);

    const work = soleWork(rt);
    const child = rt.store.listTasksByWork(work.id)[0]!;
    const wake = rt.store.findTaskByRequest(mainSession(rt), `wake:${child.id}`)!;
    assert.deepEqual(api.sends.map((s) => [s.text, s.reply_parameters?.message_id ?? null]), [
      ["ACCEPTED 已受理", m1.message_id],
      ["SECOND-ANSWER 第二条答复", m2.message_id],
      [`[工作 ${work.id} 最终汇报]\nFINAL-BODY 各子任务汇总`, m1.message_id],
    ], "渠道内受理在前、汇报在后，汇报引用工作发起消息");
    const ops = reportOps(rt);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.taskId, wake.id);
    assert.equal(ops[0]!.target.channel, "telegram");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("目标固定发起入口：QQ 工作在 Telegram 轮次续派，两份汇报都发回 QQ，Telegram 零汇报", async () => {
  let workId = "";
  let wakeCalls = 0;
  const h = await harness("fin-cross", async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: text.includes("材料 B") ? "SUB-RESULT-2" : "SUB-RESULT-1" };
    if (text.includes("[编排器]")) {
      wakeCalls += 1;
      return { kind: "text", text: `FINAL-BODY-${wakeCalls}` };
    }
    if (text.includes("TG-MORE")) {
      // 拥有者在另一入口的消息任务续派原工作（唤醒轮次本身不能委派）
      if (afterTool(req)) return { kind: "text", text: "TG-ACCEPTED 二轮已受理" };
      return { kind: "tool_calls", calls: [{ id: "d2", name: "subagent_delegate", arguments: { request: "二轮核对", key: "r2", work_id: workId, materials: [{ kind: "text", text: "材料 B" }] } }] };
    }
    if (text.includes("QQ-LATER")) return { kind: "text", text: "LATER-ANSWER 之后的会话回答" };
    if (afterTool(req)) return { kind: "text", text: "ACCEPTED 已受理" };
    if (text.includes("QQ-DELEG")) {
      return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "一轮调研", key: "r1", materials: [{ kind: "text", text: "材料 A" }] } }] };
    }
    return { kind: "text", text: "OK" };
  }, { telegram: true });
  const rt = await Runtime.start(h.config);
  const api = h.api!;
  try {
    await prepareQq(rt, h.onebot);
    await prepareTelegram(rt, h.apiBase!);
    push(h.onebot, 1, "QQ-DELEG 请调研");
    await waitFor("第一份最终汇报已送达（一轮收尾）", () => sendTexts(h.onebot).filter((t) => t.includes("最终汇报")).length === 1, 30_000);
    const work = soleWork(rt);
    workId = work.id;

    // Telegram 轮次续派：该消息自己的受理回复发 Telegram，工作收尾汇报仍发 QQ
    api.push({ text: "TG-MORE 按原工作再核一遍", from: TG_OWNER });
    await waitFor("第二份最终汇报已送达（二轮收尾）", () => sendTexts(h.onebot).filter((t) => t.includes("最终汇报")).length === 2, 30_000);

    const execs = rt.store.listTasksByWork(work.id);
    assert.equal(execs.length, 2, "Telegram 轮次续派产生了同工作的第二次执行");
    const wake1 = rt.store.findTaskByRequest(mainSession(rt), `wake:${execs[0]!.id}`)!;
    const wake2 = rt.store.findTaskByRequest(mainSession(rt), `wake:${execs[1]!.id}`)!;
    const ops = reportOps(rt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    assert.equal(ops.length, 2, "两次收尾各一份，键不同");
    assert.notEqual(ops[0]!.sourceKey, ops[1]!.sourceKey);
    const originEvent = rt.store.getInboundEvent(rt.store.getTask(work.originTaskId)!.sourceEventId!)!;
    assert.equal(originEvent.source, "qq_private");
    for (const [op, wake] of [[ops[0]!, wake1], [ops[1]!, wake2]] as const) {
      assert.equal(op.taskId, wake.id, "发送记录的 taskId 为各自收尾唤醒任务");
      assert.equal(op.target.channel, "qq_private", "另一入口续派后仍发回发起入口");
      assert.equal(op.sourceKey.split("#")[0], originEvent.id, "来源按发起链钉版，不取当前入口");
    }
    assert.deepEqual(sendTexts(h.onebot), ["ACCEPTED 已受理", `[工作 ${work.id} 最终汇报]\nFINAL-BODY-1`, `[工作 ${work.id} 最终汇报]\nFINAL-BODY-2`]);
    assert.deepEqual(api.sends.map((s) => s.text), ["TG-ACCEPTED 二轮已受理"], "Telegram 只收到自己消息的答复，没有汇报");

    // 正文按收尾唤醒任务钉版，不随后续会话最新回答变化
    push(h.onebot, 3, "QQ-LATER 汇报之后再来一条");
    await waitFor("后续消息已回复", () => sendTexts(h.onebot).some((t) => t.includes("LATER-ANSWER")), 20_000);
    assert.ok(!reportOps(rt).some((op) => op.text.includes("LATER-ANSWER")), "汇报正文不取会话最新回答");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("非 IM 来源零记录：TUI 直提与 dev 会话发起的工作不产生汇报", async () => {
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

    // 定时来源：宿主以定时任务为父直接登记工作（模型层本就拒绝调度来源委派），
    // 来源事件不是 IM，收尾同样零记录
    const { event: schedEvent } = await rt.orchestrator!.registerInboundEvent({ source: "scheduler", externalId: "fin-sched-1", targetRole: "main", body: "定时触发" });
    await waitFor("定时任务完成", () => rt.store.getInboundEvent(schedEvent.id)?.status === "done", 30_000);
    const schedTask = rt.store.getTask(rt.store.getInboundEvent(schedEvent.id)!.taskId!)!;
    const schedDeleg = await rt.subagents!.delegate({ parentTaskId: schedTask.id, key: "s1", request: "定时调研", readPaths: null, materials: [{ kind: "text", text: "材料 S" }], paramsDigest: "s1" });
    await waitFor("定时来源工作的唤醒完成", () => {
      const wake = rt.store.findTaskByRequest(mainSession(rt), `wake:${schedDeleg.task.id}`);
      return rt.store.getTask(schedDeleg.task.id)!.status === "completed" && wake?.status === "completed";
    }, 30_000);
    const wakeInput = rt.store.findTaskByRequest(mainSession(rt), `wake:${schedDeleg.task.id}`)!.input;
    assert.ok(!wakeInput.includes("[最终汇报]"), "非 IM 工作的唤醒输入不附汇报说明");

    assert.equal(reportOps(rt).length, 0, "TUI/dev/定时来源不产生任何汇报记录");
    assert.equal(allOps(rt).length, 0, "也没有任何 owner_reply 发送");
    assert.equal(sends(h.onebot).length, 0);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("并发与补充收尾：唤醒 1 时仍有未收尾唤醒则不汇报，后终态唤醒只汇报一份；补充再收尾键不同", async () => {
  const subGate = deferred();
  const wakeGate = deferred();
  let subCalls = 0;
  let wakeCalls = 0;
  const h = await harness("fin-conc", async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      subCalls += 1;
      if (subCalls === 1) await subGate.promise;
      return { kind: "text", text: `SUB-RESULT-${subCalls}` };
    }
    if (text.includes("[编排器]")) {
      wakeCalls += 1;
      if (wakeCalls === 2) await wakeGate.promise;
      return { kind: "text", text: `WAKE-ANSWER-${wakeCalls}` };
    }
    if (afterTool(req)) return { kind: "text", text: "ACCEPTED 已受理" };
    return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "调研", key: "r1", materials: [{ kind: "text", text: "材料 A" }] } }] };
  });
  const rt = await Runtime.start(h.config);
  try {
    await prepareQq(rt, h.onebot);
    push(h.onebot, 1, "QQ-DELEG 请调研");
    await waitFor("受理回复已送达", () => sendTexts(h.onebot).some((t) => t.includes("ACCEPTED")), 20_000);
    const main = mainSession(rt);
    const work = soleWork(rt);
    const taskA = rt.store.getTask(work.originTaskId)!;
    const agent = rt.store.getSubAgent(work.subAgentId)!;

    // 冻结 main 队列：两条执行都终态、两个唤醒都排队但尚未运行
    rt.store.setSessionQueueState(main, "paused", "test_fixture");
    const child1 = rt.store.listTasksByWork(work.id)[0]!;
    subGate.resolve();
    await waitFor("执行 1 终态且唤醒 1 已排队", () => rt.store.getTask(child1.id)!.status === "completed" && rt.store.findTaskByRequest(main, `wake:${child1.id}`) !== null, 30_000);
    await waitFor("SubAgent 空闲可续派", () => rt.store.getSubAgent(agent.id)!.state === "idle", 30_000);
    const again = await rt.subagents!.delegate({ parentTaskId: taskA.id, key: "r2", request: "第二轮", workId: work.id, readPaths: null, materials: [{ kind: "text", text: "材料 B" }], paramsDigest: "d2" });
    const child2 = again.task;
    await waitFor("执行 2 终态且唤醒 2 已排队", () => rt.store.getTask(child2.id)!.status === "completed" && rt.store.findTaskByRequest(main, `wake:${child2.id}`) !== null, 30_000);

    // 放行：唤醒 1 先跑——此时唤醒 2 尚未记录结果（这里被模型闸门挂住），唤醒 1 不汇报
    await rt.resumeQueue(main);
    const wake1 = rt.store.findTaskByRequest(main, `wake:${child1.id}`)!;
    await waitFor("唤醒 1 完成", () => rt.store.getTask(wake1.id)!.status === "completed", 30_000);
    await waitFor("唤醒 2 模型调用已挂住", () => wakeCalls === 2, 30_000);
    assert.equal(reportOps(rt).length, 0, "仍有未收尾唤醒时不汇报");

    wakeGate.resolve();
    const wake2 = rt.store.findTaskByRequest(main, `wake:${child2.id}`)!;
    await waitFor("最终汇报已送达", () => sendTexts(h.onebot).some((t) => t.includes("最终汇报")), 30_000);
    const ops = reportOps(rt);
    assert.equal(ops.length, 1, "两个并发唤醒只产生一份汇报");
    assert.equal(ops[0]!.taskId, wake2.id, "由后终态的唤醒汇报");
    assert.equal(ops[0]!.text, `[工作 ${work.id} 最终汇报]\nWAKE-ANSWER-2`);
    assert.ok(ops[0]!.sourceKey.endsWith(`:${child2.id}`));

    // 补充原工作（第三次执行）再次收尾：产生新的一份，键各不相同
    await waitFor("SubAgent 再次空闲", () => rt.store.getSubAgent(agent.id)!.state === "idle", 30_000);
    const third = await rt.subagents!.delegate({ parentTaskId: taskA.id, key: "r3", request: "第三轮", workId: work.id, readPaths: null, materials: [{ kind: "text", text: "材料 C" }], paramsDigest: "d3" });
    await waitFor("第三次收尾汇报已送达", () => reportOps(rt).length === 2 && reportOps(rt).every((op) => op.status === "sent"), 30_000);
    const keys = reportOps(rt).map((op) => op.sourceKey).sort();
    assert.equal(new Set(keys).size, 2, "每次收尾的汇报键各不相同");
    assert.ok(keys[0]!.startsWith(`${rt.store.getInboundEvent(taskA.sourceEventId!)!.id}#work:${work.id}:`));
    assert.ok(keys.some((k) => k.endsWith(`:${third.task.id}`)));
    assert.equal(sendTexts(h.onebot).filter((t) => t.includes("最终汇报")).length, 2);
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

test("目标变化不改发：登记时目标已失效记 work_report skip；发送前重新配置则取消且新目标零发送", async () => {
  // 登记时目标已失效：唤醒终态时 QQ 已停用
  const gateA = deferred();
  const hA = await harness("fin-skip", delegateResponder({ holdSub: gateA.promise }));
  const rtA = await Runtime.start(hA.config);
  try {
    await prepareQq(rtA, hA.onebot);
    push(hA.onebot, 1, "MARK-DELEG 请调研");
    await waitFor("受理回复已送达", () => sendTexts(hA.onebot).some((t) => t.includes("ACCEPTED")), 20_000);
    const main = mainSession(rtA);
    rtA.store.setSessionQueueState(main, "paused", "test_fixture");
    gateA.resolve();
    const work = soleWork(rtA);
    const child = rtA.store.listTasksByWork(work.id)[0]!;
    await waitFor("唤醒任务已排队", () => rtA.store.getTask(child.id)!.status === "completed" && rtA.store.findTaskByRequest(main, `wake:${child.id}`) !== null, 30_000);
    await rtA.qqSetEnabled(false);
    await rtA.resumeQueue(main);
    const wake = rtA.store.findTaskByRequest(main, `wake:${child.id}`)!;
    await waitFor("唤醒完成", () => rtA.store.getTask(wake.id)!.status === "completed", 30_000);
    await rtA.scheduler!.tick();
    assert.equal(reportOps(rtA).length, 0, "目标失效不登记发送");
    const skips = (rtA.store.db.prepare("SELECT body FROM events").all() as Array<{ body: string }>).map((r) => JSON.parse(r.body)).filter((b) => b.type === "qq_private.reply_skipped");
    assert.equal(skips.length, 1);
    assert.match(skips[0]!.reason, /^work_report:target_/, "登记时目标失效按 work_report 前缀记 skip");
    assert.deepEqual(sendTexts(hA.onebot), ["ACCEPTED 已受理"], "没有向失效目标发送");
  } finally {
    await rtA.stop("test_end");
    await hA.close();
  }

  // 发送前重新配置（configVersion 推进）：pending 汇报被取消，新目标零发送
  const gateB = deferred();
  const hB = await harness("fin-retarget", delegateResponder({ holdSub: gateB.promise }));
  const rtB = await Runtime.start(hB.config);
  try {
    await prepareQq(rtB, hB.onebot);
    push(hB.onebot, 1, "MARK-DELEG 请调研");
    await waitFor("受理回复已送达", () => sendTexts(hB.onebot).some((t) => t.includes("ACCEPTED")), 20_000);
    hB.onebot.setOnline(false);
    hB.onebot.pushHeartbeat({ online: false });
    await waitFor("QQ 离线", () => rtB.qqStatus().online === false, 20_000);
    gateB.resolve();
    await waitFor("汇报已登记为 pending", () => reportOps(rtB).length === 1 && reportOps(rtB)[0]!.status === "pending", 30_000);
    const op = reportOps(rtB)[0]!;
    await configureQq(rtB, hB.onebot, OTHER);
    hB.onebot.setOnline(true);
    hB.onebot.pushHeartbeat();
    await waitFor("QQ 恢复在线", () => {
      const status = rtB.qqStatus();
      return "actualSelfId" in status && status.online === true;
    }, 20_000);
    await rtB.scheduler!.tick();
    await waitFor("旧汇报按目标变化取消", () => rtB.sched.getOp(op.id)!.status === "canceled", 20_000);
    assert.match(rtB.sched.getOp(op.id)!.errorMessage ?? "", /target_changed/, "目标 version 变化不改发");
    assert.deepEqual(sendTexts(hB.onebot), ["ACCEPTED 已受理"], "汇报未发出");
    assert.equal(sends(hB.onebot).filter((a) => String(a.params.user_id) === OTHER).length, 0, "新目标零发送");
  } finally {
    await rtB.stop("test_end");
    await hB.close();
  }
});

test("发送结果不明记 effect_unknown 不自动重发（含重启）；Telegram 429 同一记录按 not_before 再发", async () => {
  const gateA = deferred();
  const hA = await harness("fin-ambiguous", delegateResponder({ holdSub: gateA.promise }));
  let rtA = await Runtime.start(hA.config);
  try {
    await prepareQq(rtA, hA.onebot);
    push(hA.onebot, 1, "MARK-DELEG 请调研");
    await waitFor("受理回复已送达", () => sendTexts(hA.onebot).some((t) => t.includes("ACCEPTED")), 20_000);
    hA.onebot.setSendBehavior("silent");
    gateA.resolve();
    await waitFor("汇报按结果不明收尾", () => reportOps(rtA).length === 1 && reportOps(rtA)[0]!.status === "effect_unknown", 30_000);
    await rtA.scheduler!.tick();
    assert.equal(sendTexts(hA.onebot).filter((t) => t.includes("最终汇报")).length, 1, "结果不明不重发");
    await rtA.stop("test_restart");
    rtA = await Runtime.start(hA.config);
    await rtA.scheduler!.tick();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reportOps(rtA)[0]!.status, "effect_unknown", "重启不重置结论");
    assert.equal(sends(hA.onebot).filter((a) => JSON.stringify(a.params).includes("最终汇报")).length, 1, "重启后不自动重发");
  } finally {
    await rtA.stop("test_end");
    await hA.close();
  }

  const gateB = deferred();
  const hB = await harness("fin-rl", delegateResponder({ holdSub: gateB.promise }), { telegram: true });
  const rtB = await Runtime.start(hB.config);
  const api = hB.api!;
  try {
    await prepareTelegram(rtB, hB.apiBase!);
    api.push({ text: "MARK-DELEG 请调研", from: TG_OWNER });
    await waitFor("受理回复已送达", () => api.sends.some((s) => s.text.includes("ACCEPTED")), 20_000);
    let limited = false;
    api.behavior = (body, n) => {
      if (body.text.includes("最终汇报") && !limited) {
        limited = true;
        return { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } } };
      }
      return { status: 200, body: { ok: true, result: { message_id: 3000 + n } } };
    };
    gateB.resolve();
    await waitFor("限流后同一记录再发成功", () => reportOps(rtB).length === 1 && reportOps(rtB)[0]!.status === "sent", 30_000);
    const attempts = api.sends.filter((s) => s.text.includes("最终汇报"));
    assert.equal(attempts.length, 2, "限流只按 not_before 再发一次同一记录");
    assert.deepEqual(attempts[0], attempts[1], "再发的是原目标与原正文");
  } finally {
    await rtB.stop("test_end");
    await hB.close();
  }
});

test("授权不扩大：唤醒轮次的外发请求被拒（无可信目标），不自动外发；工作汇报不受其影响", async () => {
  const h = await harness("fin-scope", async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-RESULT" };
    if (text.includes("[编排器]")) {
      if (afterTool(req)) return { kind: "text", text: "FINAL-BODY 汇总" };
      return { kind: "tool_calls", calls: [{ id: "n1", name: "notification_enqueue", arguments: { content: [{ kind: "text", text: "WAKE-NOTIFY 唤醒轮次要发通知" }], reason: "通知" } }] };
    }
    if (afterTool(req)) return { kind: "text", text: "ACCEPTED 已受理" };
    return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "调研", key: "r1", materials: [{ kind: "text", text: "材料 A" }] } }] };
  });
  const rt = await Runtime.start(h.config);
  try {
    await prepareQq(rt, h.onebot);
    push(h.onebot, 1, "MARK-DELEG 请调研");
    await waitFor("工作汇报已送达", () => sendTexts(h.onebot).some((t) => t.includes("最终汇报")), 30_000);
    const work = soleWork(rt);
    const child = rt.store.listTasksByWork(work.id)[0]!;
    const wake = rt.store.findTaskByRequest(mainSession(rt), `wake:${child.id}`)!;
    // 唤醒轮次没有钉版的可信通知目标：外发请求被拒，不产生审批、不登记发送
    const wakeToolResults = h.model.calls
      .filter((c) => afterTool(c) && inputText(c).includes("[编排器]"))
      .map((c) => {
        const m = c.messages[c.messages.length - 1] as any;
        return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      })
      .join("\n");
    assert.match(wakeToolResults, /不能外发|未配置可信/);
    assert.equal(rt.store.listConfirmationsByTask(wake.id).length, 0);
    assert.ok(!sendTexts(h.onebot).some((t) => t.includes("WAKE-NOTIFY")), "被拒通知不外发");
    assert.ok(!allOps(rt).some((op) => op.text.includes("WAKE-NOTIFY")), "被拒通知不登记发送操作");
    assert.deepEqual(sendTexts(h.onebot), ["ACCEPTED 已受理", `[工作 ${work.id} 最终汇报]\nFINAL-BODY 汇总`]);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});
