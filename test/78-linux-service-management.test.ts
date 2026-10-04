/**
 * agent-direction issue 09：通过 IM 管理 Linux 服务（service_inspect / service_manage）。
 *
 * 证据分类：本文件全部是离线证据——模拟 IM 平台（回环 OneBot + FakeBotApi）+
 * 受控 helper 替身（test/helpers/fake-service-helper.mjs，文件系统模拟 systemd，
 * fd2 前缀行 JSON 协议与拒绝原因码同 deploy/systemd/ruukoto-service.mjs）；真实
 * systemd/提权/sudoers/真实 .service 重启证据见
 * .scratch/agent-direction/smoke-09-linux-service-management.mts（另案在真实 Linux 执行）。
 *
 * 端到端（真实 Runtime + mock 模型 + helper 替身真实 spawn）：
 * - Telegram/QQ 双平台：状态检查 → 恰一个逐次审批（service_operation 范围）→ 原入口
 *   通知/详情 → 批准恰好执行一次（starts 恰好 +1、InvocationID 更新）→ 原入口结果
 *   「管理命令结果」与「随后观察到的服务状态」分述；tool_result 事件带产物引用且
 *   正常流程产物 complete；重复决定不重放（starts 不变）；拒绝零执行；
 * - 边界：dev 会话/QQ 群被任务工具白名单阻止且 helper 零调用；main 不获得 bash；
 *   错误产品/无配置/非 Linux 未显式放行一律不装配；篡改目标（通配符/模板/路径/
 *   选项/固定拒绝清单/命令单元/白名单外/别名）全部拒绝；auto-review 绝不自动批准，
 *   full_access 同样逐次审批；
 * - 取消与恢复：等待审批中中断=已知未执行；批准后在途中断=任务中断、op 效果未知、
 *   starts 不增、helper stop-op 有调用、产物 partial 且引用已接事件；停止查询失败
 *   占用保留；待决/已批准未消费跨重启一律失效零执行；已消费在途跨重启标效果未知、
 *   不自动重发。
 *
 * 模块/协议级（不经 IM；直接 createServiceTools + 真 ApprovalGate，或直接 spawn 替身）：
 * - 审批通过后策略变化 → 消费事务 recheck 失败、批准失效、零管理请求；
 *   快照后单元定义变化 → helper revision_mismatch（launched:false，已知未执行，
 *   批准已消费需新审批）；
 * - 同 hostOpId 重复启动 already_claimed；先手 stop-requested 拦下迟到启动；
 *   stop-op 未认领 opId 创建认领且 exited:true，查询失败 exited:false；
 *   应答行非 JSON 明确 protocol_error；helper 缺失明确失败；
 *   fd2 混入无前缀噪声（systemd-run 透传形态）时仍按前缀行解析；
 *   restart 成功但后状态查询失败时保留「管理命令结果」并说明无法核实。
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { createServiceTools, type ServiceToolsDeps } from "../src/agent/service-tools.ts";
import type { HostToolContext } from "../src/agent/host-tools.ts";
import { ApprovalGate } from "../src/agent/approval-gate.ts";
import { ToolOpLedger } from "../src/agent/tool-op-ledger.ts";
import { ArtifactStore } from "../src/agent/artifacts.ts";
import { createManagedProcessRegistry } from "../src/agent/managed-processes.ts";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";

const UNIT = "ruukoto-service-test.service";
const ALIAS_UNIT = "alias-test.service";
const QQ_OWNER = "880001";
const TG_TOKEN = "123456:SECRET-TOKEN-XYZ";
const TG_OWNER = 42;
const QQ_TIMEOUTS = { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 50, reconnectMaxMs: 150, sweepIntervalMs: 80 };

// ---------- 受控 helper 替身环境（状态目录即替身副本目录） ----------

interface FakeSvc {
  dir: string;
  helperPath: string;
  policyPath: string;
  service(): NonNullable<RuntimeConfig["service"]>;
  state(): Record<string, any>;
  starts(): number;
  invocationId(): string;
  calls(): string[][];
  restarts(): string[][];
  stopOps(): string[][];
  touch(name: string, content?: string): void;
}

function setupFakeService(root: string): FakeSvc {
  const dir = fs.mkdtempSync(path.join(root, "fake-svc-"));
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), path.join(dir, "fake-service-helper.mjs"));
  fs.mkdirSync(path.join(dir, "units"));
  fs.mkdirSync(path.join(dir, "ops"));
  const policyPath = path.join(dir, "services.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      machineId: "fake-machine-0001",
      execUid: 1,
      execGid: 1,
      services: { [UNIT]: { actions: ["restart"] }, [ALIAS_UNIT]: { actions: ["restart"] } },
    }),
  );
  const unitDef = "[Service]\nExecStart=/usr/bin/true\n";
  fs.writeFileSync(path.join(dir, "units", UNIT), unitDef);
  fs.writeFileSync(path.join(dir, "units", ALIAS_UNIT), unitDef);
  const base = {
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    mainPid: 1234,
    result: "success",
    activeEnterTimestamp: "2026-10-03T00:00:00Z",
    starts: 1,
  };
  const stateOf = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as Record<string, any>;
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    [UNIT]: { ...base, invocationId: "inv-initial-1" },
    [ALIAS_UNIT]: { ...base, invocationId: "inv-alias-1", aliasOf: UNIT },
  }));
  const calls = (): string[][] => {
    try {
      return fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return {
    dir,
    helperPath: path.join(dir, "fake-service-helper.mjs"),
    policyPath,
    service: () => ({
      helperPath: path.join(dir, "fake-service-helper.mjs"),
      policyPath,
      useSudo: false,
      allowNonLinuxPlatform: true,
      timeouts: { inspectMs: 5_000, restartMs: 10_000, stopMs: 2_500 },
    }),
    state: () => stateOf()[UNIT],
    starts: () => Number(stateOf()[UNIT].starts),
    invocationId: () => String(stateOf()[UNIT].invocationId),
    calls,
    restarts: () => calls().filter((c) => c[0] === "restart"),
    stopOps: () => calls().filter((c) => c[0] === "stop-op"),
    touch: (name, content = "") => fs.writeFileSync(path.join(dir, name), content),
  };
}

const REPLY_PREFIX = "RUUKOTO_SERVICE_REPLY ";

/** 从 stderr 提取应答前缀行（与 service-tools 客户端同一规则：第一条前缀行）。 */
function replyFromStderr(stderr: string): any {
  const line = stderr.split("\n").find((l) => l.startsWith(REPLY_PREFIX));
  assert.ok(line !== undefined, `应答前缀行存在：${stderr.slice(0, 200)}`);
  return JSON.parse(line.slice(REPLY_PREFIX.length).trim());
}

/** 直接 spawn 替身（协议级断言用；经环境变量注入状态目录）。 */
function spawnHelper(dir: string, args: string[]): { status: number | null; reply: any; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(dir, "fake-service-helper.mjs"), ...args], {
    env: { PATH: "/usr/bin:/bin", RUUKOTO_FAKE_HELPER_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { status: r.status, reply: replyFromStderr(r.stderr ?? ""), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function revisionsOf(dir: string): { policy: string; unit: string } {
  const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  return { policy: sha(path.join(dir, "services.json")), unit: sha(path.join(dir, "units", UNIT)) };
}

// ---------- 脚本化模型 ----------

function svcResponder(): Responder {
  return async (req) => {
    const last = req.messages.at(-1) as any;
    if (last?.role === "tool") {
      const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      return { kind: "text", text: `FINAL: ${text.slice(0, 1200)}` };
    }
    const text = lastUserText(req);
    const status = text.match(/SVC-STATUS\s+(\S+)/);
    if (status) return { kind: "tool_calls", calls: [{ id: "svc-ins-1", name: "service_inspect", arguments: { unit: status[1] } }] };
    const restart = text.match(/SVC-RESTART\s+(\S+)/);
    if (restart) return { kind: "tool_calls", calls: [{ id: "svc-rst-1", name: "service_manage", arguments: { unit: restart[1], action: "restart" } }] };
    if (text.includes("TRY-SVC-MANAGE")) return { kind: "tool_calls", calls: [{ id: "try-svc-1", name: "service_manage", arguments: { unit: UNIT, action: "restart" } }] };
    if (text.includes("TRY-SVC-INSPECT")) return { kind: "tool_calls", calls: [{ id: "try-svc-2", name: "service_inspect", arguments: { unit: UNIT } }] };
    if (text.includes("TRY-BASH")) return { kind: "tool_calls", calls: [{ id: "try-bash-1", name: "bash", arguments: { command: "true" } }] };
    return { kind: "text", text: "REPLY-TEXT" };
  };
}

/** 模型是否看到了针对某工具的阻止/不可用错误（SDK 未知工具与宿主白名单两种文案都算被阻止）。 */
const modelSawBlocked = (model: MockModelServer, toolName: string) =>
  model.calls.some((c) =>
    c.messages.some((m: any) => m.role === "tool" && JSON.stringify(m.content).includes(toolName) && /白名单不含|unavailable|不可用|未登记|not found/.test(JSON.stringify(m.content))),
  );

// ---------- 双平台 harness（沿用 test/77 模式，注入 service 部署配置） ----------

interface ImHarness {
  dirs: Awaited<ReturnType<typeof makeTestDirs>>["dirs"];
  config: RuntimeConfig;
  svc: FakeSvc;
  model: MockModelServer;
  onebot: MockOneBot;
  api: FakeBotApi;
  apiBase: string;
  rt: Runtime | null;
  close(): Promise<void>;
}

async function imHarness(prefix: string, responder: Responder): Promise<ImHarness> {
  const { dirs } = await makeTestDirs(prefix, 0);
  const onebot = await startMockOneBot({});
  const model = new MockModelServer(responder);
  await writeModelsJson(dirs, await model.start());
  const api = new FakeBotApi({ token: TG_TOKEN, ownerId: TG_OWNER });
  const apiBase = await api.start();
  const svc = setupFakeService(dirs.root);
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    qq: QQ_TIMEOUTS,
    telegram: { pollTimeoutSec: 1, backoffMs: 50 },
    scheduler: { tickMs: 30, sendTimeoutMs: 1_000 },
    service: svc.service(),
  };
  return {
    dirs,
    config,
    svc,
    model,
    onebot,
    api,
    apiBase,
    rt: null,
    async close() {
      await onebot.close();
      await api.close();
      await model.close();
      await cleanupDirs(dirs);
    },
  };
}

async function startWithPlatforms(h: ImHarness): Promise<Runtime> {
  const rt = await Runtime.start(h.config);
  h.rt = rt;
  await rt.addCredentialBinding({ name: "qq-test", host: h.onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: QQ_OWNER });
  await rt.qqSetEnabled(true);
  await rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
  await rt.telegramConfigure({ apiBase: h.apiBase, credential: "tg", ownerUserId: String(TG_OWNER) });
  await rt.telegramSetEnabled(true);
  await waitFor("QQ 已核实登录账号在线", () => rt.qqStatus().online === true);
  await waitFor("Telegram 轮询在线", () => rt.telegramStatus().online === true);
  return rt;
}

// ---------- 通用辅助 ----------

const tgTexts = (api: FakeBotApi) => api.sends.map((s) => String(s.text));
const qqTexts = (onebot: MockOneBot) =>
  onebot.actions
    .filter((a) => a.action === "send_private_msg")
    .map((a) => (a.params.message as any[]).filter((s) => s?.type === "text").map((s) => String(s.data?.text ?? "")).join(""));
const pushQq = (onebot: MockOneBot, messageId: number, text: string) =>
  onebot.pushPrivateMessage({ userId: QQ_OWNER, messageId, segments: [{ type: "text", data: { text } }] });

async function waitPending(rt: Runtime): Promise<void> {
  await waitFor("待审批数 1", () => rt.store.listConfirmationsByStatus("pending").length === 1);
}
const solePending = (rt: Runtime) => {
  const all = rt.store.listConfirmationsByStatus("pending");
  assert.equal(all.length, 1, "恰有一个待审批");
  return all[0]!;
};
const taskEvents = (rt: Runtime, taskId: string, type: string): any[] =>
  rt.store.getTaskEventsAfter(taskId, 0, 1000).filter((e) => e.body.type === type).map((e) => e.body);
const toolResults = (rt: Runtime, taskId: string): any[] => taskEvents(rt, taskId, "task.tool_result");
const serviceManagerOf = (rt: Runtime) => (rt as unknown as { serviceManager: unknown }).serviceManager;

// ==================================================================
// 端到端：双平台全流程（覆盖点 1/2/3/4）
// ==================================================================

test("Telegram 全流程：状态检查 → 逐次审批 → 批准恰好一次执行 → 原入口结果；重复决定不重放（覆盖点 1/4）", async () => {
  const h = await imHarness("svc-tg-flow", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    // 状态检查（只读，直接执行）
    h.api.push({ text: `SVC-STATUS ${UNIT}` });
    await waitFor("状态检查最终回答", () => tgTexts(h.api).some((t) => t.includes("FINAL:") && t.includes("ActiveState=active") && t.includes("inv-initial-1")));
    assert.equal(h.svc.restarts().length, 0);
    assert.equal(h.svc.starts(), 1);

    // restart：恰一个 pending 审批，范围与参数快照钉版
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    assert.equal(conf.toolName, "service_manage");
    const scope = conf.scope as any;
    assert.equal(scope.kind, "service_operation");
    assert.equal(scope.unit, UNIT);
    assert.equal(scope.action, "restart");
    assert.equal(scope.machineId, "fake-machine-0001");
    assert.match(scope.policyRevision, /^[0-9a-f]{64}$/);
    assert.match(scope.unitRevision, /^[0-9a-f]{64}$/);
    assert.equal(scope.taskId, conf.taskId);
    assert.equal(scope.toolOpId, conf.toolOpId);
    const params = conf.params as any;
    assert.equal(params.unit, UNIT);
    assert.equal(params.action, "restart");
    assert.equal(params.machine_id, "fake-machine-0001");
    assert.equal(params.state_before.invocationId, "inv-initial-1");
    assert.equal(typeof params.note, "string");

    // 原入口【需要审批】通知（含审批 ID 与决定/详情命令）
    await waitFor("通知送达 Telegram", () => tgTexts(h.api).some((t) => t.includes("【需要审批】") && t.includes(conf.id)));
    const notice = tgTexts(h.api).find((t) => t.includes("【需要审批】"))!;
    assert.ok(notice.includes(`/approve ${conf.id} ${conf.permissionVersion}`));
    assert.ok(notice.includes(`/reject ${conf.id} ${conf.permissionVersion}`));
    assert.ok(notice.includes(`/approval ${conf.id}`));

    // 详情含 unit 与 restart；等待期间模型调用数不变、不建普通任务
    const callsBefore = h.model.calls.length;
    h.api.push({ text: `/approval ${conf.id}` });
    await waitFor("详情回执", () => tgTexts(h.api).some((t) => t.includes(`审批 ${conf.id}`)));
    const detail = tgTexts(h.api).find((t) => t.includes(`审批 ${conf.id}`))!;
    assert.ok(detail.includes(UNIT) && detail.includes("restart"));
    assert.equal(h.model.calls.length, callsBefore, "审批命令零额外模型调用");
    assert.equal(rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId).length, 2, "命令不建普通任务");

    // 批准 → 恰好一次执行
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("批准回执", () => tgTexts(h.api).some((t) => t.includes("已接受批准") && t.includes(conf.id)));
    await waitFor("任务完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(h.svc.starts(), 2, "starts 恰好增加一次");
    assert.equal(h.svc.restarts().length, 1, "helper restart 恰好一次");
    assert.ok(rt.store.getConfirmation(conf.id)!.consumedAt, "批准已消费");
    const newInv = h.svc.invocationId();
    assert.notEqual(newInv, "inv-initial-1", "InvocationID 已更新（新启动周期）");

    // 原入口最终回答：管理命令结果与随后观察到的服务状态分述
    await waitFor("原入口最终回答", () => tgTexts(h.api).some((t) => t.includes("FINAL:") && t.includes("管理命令结果") && t.includes("随后观察到的服务状态")));
    const final = tgTexts(h.api).find((t) => t.includes("管理命令结果"))!;
    assert.ok(final.includes(newInv), "最终回答含新 InvocationID");

    // task.tool_result 事件带产物引用；正常流程产物全部 complete
    const results = toolResults(rt, conf.taskId);
    assert.ok(results.some((e: any) => (e.artifactIds ?? []).length > 0), "tool_result 事件带产物引用");
    const arts = rt.store.listArtifactsByTask(conf.taskId);
    assert.ok(arts.length >= 2, "原始输出产物已登记");
    for (const a of arts) assert.equal(a.status, "complete", `正常流程产物 complete：${a.name}`);

    // 重复决定不重放（覆盖点 4）
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("重复决定回执", () => tgTexts(h.api).some((t) => t.includes("已失效或已处理") && t.includes(conf.id)));
    assert.equal(h.svc.starts(), 2, "同一审批第二次决定不再执行");
    assert.equal(h.svc.restarts().length, 1);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("QQ 全流程：私聊委托 → 审批通知/批准 → 恰好一次执行 → 原入口文字回执（覆盖点 2）", async () => {
  const h = await imHarness("svc-qq-flow", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    pushQq(h.onebot, 1, `SVC-STATUS ${UNIT}`);
    await waitFor("QQ 状态检查回答", () => qqTexts(h.onebot).some((t) => t.includes("FINAL:") && t.includes("ActiveState=active") && t.includes("inv-initial-1")));

    pushQq(h.onebot, 2, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    const conf = solePending(rt);
    assert.equal(conf.toolName, "service_manage");
    await waitFor("QQ 通知送达", () => qqTexts(h.onebot).some((t) => t.includes("【需要审批】") && t.includes(`/approve ${conf.id}`)));
    assert.equal(h.svc.starts(), 1, "批准前零执行");

    pushQq(h.onebot, 3, `/approve ${conf.id} ${conf.permissionVersion}`);
    await waitFor("QQ 批准回执", () => qqTexts(h.onebot).some((t) => t.includes("已接受批准") && t.includes(conf.id)));
    await waitFor("任务完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(h.svc.starts(), 2);
    assert.equal(h.svc.restarts().length, 1);
    assert.ok(rt.store.getConfirmation(conf.id)!.consumedAt);
    await waitFor("QQ 最终回答", () => qqTexts(h.onebot).some((t) => t.includes("FINAL:") && t.includes("管理命令结果") && t.includes("随后观察到的服务状态")));
    const final = qqTexts(h.onebot).find((t) => t.includes("管理命令结果"))!;
    assert.ok(final.includes(h.svc.invocationId()));
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("QQ 拒绝：restart 零执行（覆盖点 3）", async () => {
  const h = await imHarness("svc-qq-reject", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    pushQq(h.onebot, 1, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("QQ 通知送达", () => qqTexts(h.onebot).some((t) => t.includes(conf.id)));
    pushQq(h.onebot, 2, `/reject ${conf.id} ${conf.permissionVersion}`);
    await waitFor("QQ 拒绝回执", () => qqTexts(h.onebot).some((t) => t.includes("已拒绝") && t.includes(conf.id)));
    await waitFor("任务收尾", () => rt.store.getTask(conf.taskId)!.status === "completed");
    assert.equal(h.svc.starts(), 1, "拒绝后零执行");
    assert.equal(h.svc.restarts().length, 0, "restart 调用 0 次（calls.log）");
    assert.equal(rt.store.getConfirmation(conf.id)!.consumedAt, null);
    await waitFor("QQ 最终回答含拒绝语义", () => qqTexts(h.onebot).some((t) => t.includes("FINAL:") && t.includes("拥有者拒绝执行 service_manage")));
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

// ==================================================================
// 端到端：入口与装配边界（覆盖点 5/6/7/8）
// ==================================================================

test("非 main 不得使用：dev 会话与 QQ 群被白名单阻止（helper 零调用）；main 不获得 bash（覆盖点 5）", async () => {
  const h = await imHarness("svc-blocked", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    // 普通 dev 会话任务提出 service_manage → 被任务工具白名单阻止
    const project = rt.store.createProject("dev-project");
    const workDir = fs.mkdtempSync(path.join(h.dirs.root, "work-"));
    const stat = fs.statSync(workDir);
    const devSession = rt.store.createSession({ projectId: project.id, cwd: workDir, cwdReal: fs.realpathSync(workDir), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "pi-dev", confirmTools: [] });
    const devTask = await rt.submit({ sessionId: devSession.id, requestId: "dev-svc-1", input: "TRY-SVC-MANAGE", modelSelection: rt.defaultSelection });
    await waitFor("dev 任务完成", () => rt.store.getTask(devTask.id)!.status === "completed");
    assert.ok(modelSawBlocked(h.model, "service_manage"), "dev 会话调用被任务工具白名单阻止");
    assert.equal(h.svc.calls().length, 0, "calls.log 零增长");

    // main 会话任务提出 bash → main 不获得 bash
    const main = rt.store.getAgentRole("main")!;
    const mainTask = await rt.submit({ sessionId: main.sessionId, requestId: "main-bash-1", input: "TRY-BASH", modelSelection: rt.defaultSelection });
    await waitFor("main 任务完成", () => rt.store.getTask(mainTask.id)!.status === "completed");
    assert.ok(modelSawBlocked(h.model, "bash"), "main 不获得 bash");
    assert.equal(h.svc.calls().length, 0);

    // 核心群聊已退役（issue 20）：群 @ 消息被忽略——零收件、零任务、零模型调用
    await new Promise((r) => setTimeout(r, 300));
    h.onebot.pushGroupMessage({
      groupId: "100001",
      userId: QQ_OWNER,
      messageId: 9,
      segments: [
        { type: "at", data: { qq: MOCK_QQ_ACCOUNT } },
        { type: "text", data: { text: " TRY-SVC-INSPECT" } },
      ],
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((rt.store.db.prepare("SELECT * FROM qq_inbox").all() as any[]).length, 0, "群消息不登记收件");
    assert.ok(!h.model.calls.some((call) => lastUserText(call).includes("TRY-SVC-INSPECT")), "群消息零模型调用");
    assert.equal(h.svc.calls().length, 0, "群入口 helper 零调用");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("错误产品：ruukoto-dev 配置齐备也不装配（覆盖点 5）", async () => {
  const { dirs } = await makeTestDirs("svc-dev-product", 0);
  const model = new MockModelServer(svcResponder());
  try {
    await writeModelsJson(dirs, await model.start());
    const svc = setupFakeService(dirs.root);
    const rt = await Runtime.start({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      socketPath: path.join(dirs.root, "c.sock"),
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      toolFactory: (ctx) => createMockTools(ctx),
      productType: "ruukoto-dev",
      service: svc.service(),
    });
    try {
      assert.equal(serviceManagerOf(rt), null, "错误产品不装配服务管理能力（工具不装配，不是静默放行）");
    } finally {
      await rt.stop("test_end");
    }
  } finally {
    await model.close();
    await cleanupDirs(dirs);
  }
});

test("平台/配置门：无 service 配置不装配（各平台）；非 Linux 且未显式放行不装配（覆盖点 6）", async () => {
  const boot = async (prefix: string, service?: RuntimeConfig["service"]) => {
    const { dirs } = await makeTestDirs(prefix, 0);
    const model = new MockModelServer(svcResponder());
    await writeModelsJson(dirs, await model.start());
    const rt = await Runtime.start({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      socketPath: path.join(dirs.root, "c.sock"),
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      toolFactory: (ctx) => createMockTools(ctx),
      service,
    });
    return {
      rt,
      dirs,
      async close() {
        await rt.stop("test_end");
        await model.close();
        await cleanupDirs(dirs);
      },
    };
  };
  // 无 service 配置：任何平台都不装配
  const noCfg = await boot("svc-nocfg");
  try {
    assert.equal(serviceManagerOf(noCfg.rt), null, "无 service 配置：不装配");
  } finally {
    await noCfg.close();
  }
  if (process.platform === "linux") {
    // 「未显式放行即不装配」只在非 Linux 成立（Linux 本身是目标平台，照常装配）；
    // 本机为 Linux，该断言跳过并注明于此。
    return;
  }
  const { dirs: dirs2 } = await makeTestDirs("svc-platform-gate", 0);
  const svc = setupFakeService(dirs2.root);
  const gated = await boot("svc-platform-gate", { ...svc.service(), allowNonLinuxPlatform: undefined });
  try {
    assert.equal(serviceManagerOf(gated.rt), null, "非 Linux 且未显式放行：不装配");
  } finally {
    await gated.close();
    await cleanupDirs(dirs2);
  }
});

test("目标篡改全部拒绝：通配符/模板/路径/选项/固定拒绝清单/命令单元/白名单外/别名（覆盖点 7）", async () => {
  const h = await imHarness("svc-tamper", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    const cases = [
      "*.service",
      "foo@1.service",
      "/etc/x.service",
      "--help.service",
      "ruukoto-backend.service",
      `ruukoto-service-op-op_${"a".repeat(24)}.service`,
      "other.service",
    ];
    for (const [i, target] of cases.entries()) {
      const before = tgTexts(h.api).filter((t) => t.includes("FINAL:")).length;
      h.api.push({ text: `SVC-STATUS ${target}` });
      await waitFor(`篡改目标 ${target} 被拒绝并回报`, () => tgTexts(h.api).filter((t) => t.includes("FINAL:")).length > before && tgTexts(h.api).some((t) => t.includes("FINAL:") && t.includes("服务管理不可用") && t.includes(target)));
      assert.equal(h.svc.restarts().length, 0);
    }
    // 白名单内的别名：alias_refused
    const before = tgTexts(h.api).filter((t) => t.includes("FINAL:")).length;
    h.api.push({ text: `SVC-STATUS ${ALIAS_UNIT}` });
    await waitFor("别名被拒绝", () => tgTexts(h.api).filter((t) => t.includes("FINAL:")).length > before && tgTexts(h.api).some((t) => t.includes("alias_refused")));
    assert.equal(h.svc.starts(), 1, "一切篡改零执行，状态不变");
    assert.equal(h.svc.invocationId(), "inv-initial-1");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("逐次审批：auto-review 绝不自动批准；full_access 同样先审批（覆盖点 8）", async () => {
  const h = await imHarness("svc-every-approval", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    const main = rt.store.getAgentRole("main")!;
    // 注：IM 任务固定为 confirm 模式（编排器写定），这里经同会话直接提交制造
    // auto-review/full_access 任务；拥有者决定走控制面应答，与 IM /approve 进入同一
    // ApproveGate.resolve 决定路径（IM 通道全流程见前三个测试）。
    const t1 = await rt.submit({ sessionId: main.sessionId, requestId: "svc-ar-1", input: `SVC-RESTART ${UNIT}`, accessMode: "auto-review", modelSelection: rt.defaultSelection });
    await waitPending(rt);
    const c1 = solePending(rt);
    await waitFor("自动审查转人工", () => rt.store.getConfirmation(c1.id)!.reviewStatus === "asked_owner");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(rt.store.getConfirmation(c1.id)!.status, "pending", "绝不 auto approve（reviewStatus=asked_owner 且仍 pending）");
    assert.equal(h.svc.starts(), 1, "未经人工决定零执行");
    assert.equal(h.svc.restarts().length, 0);
    rt.respondConfirmation(c1.id, "approved");
    await waitFor("auto-review 任务完成", () => rt.store.getTask(t1.id)!.status === "completed");
    assert.equal(h.svc.starts(), 2, "人工批准后才执行");

    const t2 = await rt.submit({ sessionId: main.sessionId, requestId: "svc-fa-1", input: `SVC-RESTART ${UNIT}`, accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitPending(rt);
    const c2 = solePending(rt);
    assert.equal(rt.store.getTask(t2.id)!.accessMode, "full_access");
    assert.equal(h.svc.starts(), 2, "完全访问也必须先审批");
    rt.respondConfirmation(c2.id, "approved");
    await waitFor("full_access 任务完成", () => rt.store.getTask(t2.id)!.status === "completed");
    assert.equal(h.svc.starts(), 3, "两次逐次审批，各恰好执行一次");
    assert.equal(h.svc.restarts().length, 2);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

// ==================================================================
// 模块/协议级（覆盖点 9-14、17）
// ==================================================================

function textOf(result: any): string {
  return (result.content as any[]).map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

interface ModuleKit {
  svc: FakeSvc;
  store: Store;
  gate: ApprovalGate;
  taskId: string;
  effectUnknownOps: string[];
  call(name: string, params: Record<string, unknown>): Promise<any>;
  pendingConf(): Promise<any>;
  setApprovalImpl(fn: (input: any) => Promise<any>): void;
  close(): void;
}

/** 模块级夹具：真 Store/ApprovalGate + 替身 spawn（不经 Runtime/Driver/IM，模式参考 test/63）。 */
function moduleKit(prefix: string, overrides: { helperPath?: string } = {}): ModuleKit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ruukoto-svc-mod-${prefix}-`));
  const svc = setupFakeService(root);
  const db = new Db(root);
  const store = new Store(db);
  const gate = new ApprovalGate({ store, ledger: new ToolOpLedger(store), reviewer: () => undefined });
  const artifacts = new ArtifactStore(root, store);
  const registry = createManagedProcessRegistry();
  const project = store.createProject("p");
  const stat = fs.statSync(root);
  const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "pi-1", confirmTools: [] });
  const { task } = store.insertQueuedTask({
    sessionId: session.id,
    requestId: "r1",
    input: "svc 模块测试",
    modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" },
    submissionDigest: "r1",
  });
  store.transitionTask(task.id, ["queued"], "running", {});
  let ctx: HostToolContext = { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId: "" };
  let approvalImpl: (input: any) => Promise<any> = (input) => gate.request(input);
  const effectUnknownOps: string[] = [];
  const deps: ServiceToolsDeps = {
    coreStore: store,
    artifacts,
    registry,
    config: {
      helperPath: overrides.helperPath ?? svc.helperPath,
      policyPath: svc.policyPath,
      useSudo: false,
      sudoPath: "",
      timeouts: { inspectMs: 5_000, restartMs: 10_000, stopMs: 2_500 },
    },
    taskContext: () => ctx,
    verifyMain: () => null,
    requestApproval: (input) => approvalImpl(input),
    recordArtifact: () => {},
    markEffectUnknown: (opId) => {
      effectUnknownOps.push(opId);
    },
  };
  const tools = createServiceTools(deps);
  return {
    svc,
    store,
    gate,
    taskId: task.id,
    effectUnknownOps,
    async call(name, params) {
      ctx = { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId: `op_${randomBytes(12).toString("hex")}` };
      store.recordToolIntent({ id: ctx.hostOpId, taskId: task.id, sessionId: session.id, toolName: name, params });
      return await tools.find((t) => t.name === name)!.execute(ctx.hostOpId, params, undefined, undefined, {} as any);
    },
    async pendingConf() {
      let found: any = null;
      await waitFor("模块级待审批", () => (found = store.listConfirmationsByTask(task.id).find((c) => c.status === "pending") ?? null) !== null);
      return found;
    },
    setApprovalImpl(fn) {
      approvalImpl = fn;
    },
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("审批通过后策略变化：消费事务 recheck 失败、批准失效、helper restart 零调用（覆盖点 9）", async () => {
  const k = moduleKit("recheck");
  try {
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    // 批准到达前改写策略（任何字节变化 → sha256 变化）
    fs.writeFileSync(k.svc.policyPath, fs.readFileSync(k.svc.policyPath, "utf8") + "\n");
    k.gate.resolve(conf.id, "approved");
    await assert.rejects(exec, /服务管理策略在确认期间已变化/);
    assert.equal(k.store.getConfirmation(conf.id)!.status, "stale", "批准失效");
    assert.equal(k.store.getConfirmation(conf.id)!.consumedAt, null, "未消费");
    assert.equal(k.svc.restarts().length, 0, "helper restart 零调用");
    assert.equal(k.svc.starts(), 1, "已知未执行");
  } finally {
    k.close();
  }
});

test("批准快照后单元定义变化：helper 修订复核拒绝（已知未执行），批准已消费需新审批（覆盖点 10）", async () => {
  const k = moduleKit("unitrev");
  try {
    // 确定性 seam：获批消费与 helper 请求之间（requestApproval 包装内）改写单元定义
    k.setApprovalImpl(async (input: any) => {
      const r = await k.gate.request(input);
      if (r.approved) fs.writeFileSync(path.join(k.svc.dir, "units", UNIT), "[Service]\nExecStart=/usr/bin/false\n");
      return r;
    });
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    k.gate.resolve(conf.id, "approved");
    await assert.rejects(exec, (err: Error) => {
      assert.match(err.message, /管理操作未执行/, err.message);
      assert.match(err.message, /revision_mismatch/, err.message);
      assert.match(err.message, /新的审批/, err.message);
      return true;
    });
    assert.notEqual(k.store.getConfirmation(conf.id)!.consumedAt, null, "批准已消费");
    assert.equal(k.svc.restarts().length, 1, "helper 被调用但在请求 systemd 前拒绝");
    assert.equal(k.svc.starts(), 1, "starts 不变");
  } finally {
    k.close();
  }
});

test("同 hostOpId 重复启动：第二次 already_claimed（覆盖点 11）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-svc-proto-dup-"));
  try {
    const svc = setupFakeService(root);
    const rev = revisionsOf(svc.dir);
    const op = `op_${"a".repeat(24)}`;
    const first = spawnHelper(svc.dir, ["restart", op, rev.policy, rev.unit, UNIT]);
    assert.equal(first.reply.ok, true);
    assert.equal(first.reply.launched, true);
    assert.equal(svc.starts(), 2);
    const second = spawnHelper(svc.dir, ["restart", op, rev.policy, rev.unit, UNIT]);
    assert.equal(second.status, 64);
    assert.equal(second.reply.ok, false);
    assert.equal(second.reply.launched, false);
    assert.equal(second.reply.reasonCode, "already_claimed");
    assert.equal(svc.starts(), 2, "重复启动被拒绝，不再次重启");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("停止协议：在途 stop-requested 拦下执行（exitCode 143）；补认领/拒再启动/查询失败 exited:false（覆盖点 12）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-svc-proto-stop-"));
  try {
    const svc = setupFakeService(root);
    const rev = revisionsOf(svc.dir);
    // stop-op 对未认领 opId：创建 claim 且写 stop-requested、exited:true；此后 restart 同 ID 被拒
    // （生产 helper 的 atomic mkdir 语义：目录已存在即 already_claimed，launched:false）
    const opB = `op_${"d".repeat(24)}`;
    const stop = spawnHelper(svc.dir, ["stop-op", opB]);
    assert.equal(stop.reply.ok, true);
    assert.equal(stop.reply.exited, true);
    const claim = JSON.parse(fs.readFileSync(path.join(svc.dir, "ops", opB, "claim.json"), "utf8"));
    assert.equal(claim.claimedBy, "stop-op");
    assert.ok(fs.existsSync(path.join(svc.dir, "ops", opB, "stop-requested")));
    const late = spawnHelper(svc.dir, ["restart", opB, rev.policy, rev.unit, UNIT]);
    assert.equal(late.reply.launched, false, "停止协议先手：该 opId 永不启动");
    assert.equal(late.reply.reasonCode, "already_claimed");
    assert.equal(svc.starts(), 1);

    // 在途窗口：restart 已认领、正在「模拟执行」前等待，此时写入 stop-requested →
    // 不增加 starts，以非零退出应答（exitCode 143，对应生产 systemd-run 被停止的窗口）
    const opC = `op_${"e".repeat(24)}`;
    svc.touch("restart-delay-ms", "1500");
    const child = childProcess.spawn(process.execPath, [svc.helperPath, "restart", opC, rev.policy, rev.unit, UNIT], {
      env: { PATH: "/usr/bin:/bin", RUUKOTO_FAKE_HELPER_DIR: svc.dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errBuf: Buffer[] = [];
    (child.stdio[2] as NodeJS.ReadableStream).on("data", (c: Buffer) => errBuf.push(c));
    await waitFor("restart 已认领", () => fs.existsSync(path.join(svc.dir, "ops", opC, "claim.json")), 5_000);
    fs.writeFileSync(path.join(svc.dir, "ops", opC, "stop-requested"), "stop\n");
    const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
    assert.equal(code, 0);
    const raceReply = replyFromStderr(Buffer.concat(errBuf).toString("utf8"));
    assert.equal(raceReply.ok, true);
    assert.equal(raceReply.launched, true);
    assert.equal(raceReply.exitCode, 143, "执行前收到停止标记：非零退出应答（部分效果如实表达）");
    assert.equal(svc.starts(), 1, "starts 不增加");
    fs.rmSync(path.join(svc.dir, "restart-delay-ms"), { force: true });

    // 查询失败：exited:false（stop() 返回 false → 占用不释放的端到端语义见 16c）
    svc.touch("stop-query-fails");
    const failed = spawnHelper(svc.dir, ["stop-op", opB]);
    assert.equal(failed.reply.ok, true);
    assert.equal(failed.reply.exited, false);
    assert.equal(failed.reply.detail, "query_failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("协议错误：应答行非 JSON 明确报错，不当作成功（覆盖点 13）", async () => {
  const k = moduleKit("garbage");
  try {
    k.svc.touch("garbage-protocol");
    await assert.rejects(k.call("service_inspect", { unit: UNIT }), /未返回结构化结果/);
    assert.equal(k.svc.starts(), 1);
  } finally {
    k.close();
  }
});

test("应答只认前缀行：fd2 混入 systemd-run 透传噪声时仍正确解析（fd2 前缀协议新用例）", async () => {
  const k = moduleKit("fd2noise");
  try {
    k.svc.touch("fd2-noise");
    const result = await k.call("service_inspect", { unit: UNIT });
    const text = textOf(result);
    assert.ok(text.includes("ActiveState=active"), `混合噪声下前缀应答解析成功：${text.slice(0, 200)}`);
    assert.ok(text.includes("inv-initial-1"));
    // restart 路径同样按前缀提取（噪声混入 + 前缀应答）
    k.setApprovalImpl(async (input: any) => ({ approved: true, approvalId: "fake", params: input.params as Record<string, unknown>, value: undefined }));
    const r2 = await k.call("service_manage", { unit: UNIT, action: "restart" });
    assert.ok(textOf(r2).includes("管理命令结果"), textOf(r2).slice(0, 200));
    assert.equal(k.svc.starts(), 2);
    // 原始字节产物完整保存（噪声行与前缀行都在证据里）
    const arts = k.store.listArtifactsByTask(k.taskId);
    assert.ok(arts.length >= 2);
  } finally {
    k.close();
  }
});

test("helper 缺失：明确失败，不是静默成功（覆盖点 14）", async () => {
  const missing = path.join(os.tmpdir(), `ruukoto-no-such-helper-${randomBytes(4).toString("hex")}.mjs`);
  const k = moduleKit("missing", { helperPath: missing });
  try {
    await assert.rejects(k.call("service_inspect", { unit: UNIT }), /启动失败|未返回结构化结果/);
  } finally {
    k.close();
  }
});

test("restart 成功但后状态查询失败：保留管理命令结果并说明无法核实（覆盖点 17）", async () => {
  const k = moduleKit("after-inspect");
  try {
    k.setApprovalImpl(async (input: any) => ({ approved: true, approvalId: "fake", params: input.params as Record<string, unknown>, value: undefined }));
    k.svc.touch("fail-inspect-after-restart");
    const result = await k.call("service_manage", { unit: UNIT, action: "restart" });
    const text = textOf(result);
    assert.ok(text.includes("管理命令结果"), text);
    assert.ok(text.includes("操作后状态无法核实"), text);
    assert.equal(k.svc.starts(), 2, "重启效果已发生，如实表达为部分已知");
  } finally {
    k.close();
  }
});

// ==================================================================
// 端到端：审批管线恢复与取消（覆盖点 15/16/18）
// ==================================================================

test("helper 派发后失败：效果未知、不描述为未执行、不自动重发（code-review 修复分支）", async () => {
  const k = moduleKit("after-launch");
  try {
    k.setApprovalImpl(async (input: any) => ({ approved: true, approvalId: "fake", params: input.params as Record<string, unknown>, value: undefined }));
    k.svc.touch("fail-after-launch");
    await assert.rejects(k.call("service_manage", { unit: UNIT, action: "restart" }), /管理命令结果未知/);
    assert.equal(k.svc.starts(), 2, "restart 已生效（不能描述为零执行）");
    assert.equal(k.effectUnknownOps.length, 1, "标效果未知");
    assert.equal(k.svc.restarts().length, 1, "不自动重发");
  } finally {
    k.close();
  }
});

test("管线重启：待决与已批准未消费一律失效，零执行（覆盖点 15）", async () => {
  const h = await imHarness("svc-pipeline-recover", svcResponder());
  let rt = await startWithPlatforms(h);
  try {
    pushQq(h.onebot, 1, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    const conf = solePending(rt);
    // 已批准未消费（崩溃窗口形态，直接构造，同 test/77 恢复用例）
    rt.store.db
      .prepare(
        `INSERT INTO confirmations (id, task_id, session_id, tool_op_id, tool_name, params, scope, permission_version, status, created_at, responded_at)
         SELECT 'cnf_crafted_svc', task_id, session_id, tool_op_id, tool_name, params, scope, permission_version, 'approved', ?, ? FROM confirmations WHERE id = ?`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), conf.id);
    await rt.stop("restart");
    h.rt = null;

    rt = h.rt = await Runtime.start(h.config);
    assert.equal(rt.store.getConfirmation(conf.id)!.status, "stale", "待决审批恢复后失效");
    assert.equal(rt.store.getConfirmation("cnf_crafted_svc")!.status, "stale", "已批准未消费恢复后失效");
    assert.match(rt.store.getToolOp(conf.toolOpId)!.resultSummary ?? "", /未执行/, "审批未消费 = 已知未执行");
    assert.equal(h.svc.starts(), 1);
    assert.equal(h.svc.restarts().length, 0);
    // 旧批准消息再次到达：只回执已失效，不执行（QQ 为 WS 推送：等适配器重连后再发，避免丢消息）
    await waitFor("QQ 恢复在线", () => rt.qqStatus().online === true);
    pushQq(h.onebot, 2, `/approve ${conf.id} ${conf.permissionVersion}`);
    await waitFor("旧批准回执为已失效", () => qqTexts(h.onebot).some((t) => t.includes("已失效或已处理") && t.includes(conf.id)));
    assert.equal(h.svc.starts(), 1);
    assert.equal(h.svc.restarts().length, 0);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("管线重启：已消费在途的 restart 标效果未知、starts 不增、不自动重发（覆盖点 15）", async () => {
  const h = await imHarness("svc-inflight-recover", svcResponder());
  let rt = await startWithPlatforms(h);
  try {
    h.svc.touch("restart-delay-ms", "2500");
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("restart 已在途（delay 中）", () => h.svc.restarts().length === 1);
    await rt.stop("crash");
    h.rt = null;
    assert.equal(h.svc.starts(), 1, "模拟后台停止时重启未走完，starts 不增加");

    rt = h.rt = await Runtime.start(h.config);
    assert.equal(rt.store.getTask(conf.taskId)!.status, "interrupted");
    const op = rt.store.getToolOp(conf.toolOpId)!;
    assert.equal(op.effectUnknown, true, "已消费在途 = 效果未知");
    assert.ok(rt.store.getConfirmation(conf.id)!.consumedAt, "消费事实保留");
    const restarts = h.svc.restarts().length;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(h.svc.restarts().length, restarts, "恢复后不自动重发 restart");
    assert.equal(h.svc.starts(), 1);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("取消：等待审批中 interruptTask = 已知未执行、starts 不变（覆盖点 16a）", async () => {
  const h = await imHarness("svc-cancel-pending", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    await rt.interruptTask(conf.taskId);
    await waitFor("任务中断", () => rt.store.getTask(conf.taskId)!.status === "interrupted");
    const op = rt.store.getToolOp(conf.toolOpId)!;
    assert.match(op.resultSummary ?? "", /确认等待解除.*未执行/, "等待中取消 = 已知未执行");
    assert.equal(op.effectUnknown, false);
    assert.equal(rt.store.getConfirmation(conf.id)!.status, "stale");
    assert.equal(h.svc.starts(), 1);
    assert.equal(h.svc.restarts().length, 0);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("取消：批准后 helper 在 restart-delay 中 interruptTask = 中断、效果未知、starts 不增；产物 partial 且引用已接事件（覆盖点 16b/18）", async () => {
  const h = await imHarness("svc-cancel-inflight", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    h.svc.touch("restart-delay-ms", "2500");
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("restart 已在途（delay 中）", () => h.svc.restarts().length === 1);
    await rt.interruptTask(conf.taskId);
    await waitFor("任务中断", () => rt.store.getTask(conf.taskId)!.status === "interrupted");
    assert.equal(h.svc.starts(), 1, "延迟未走完即中断，starts 不增加");
    const op = rt.store.getToolOp(conf.toolOpId)!;
    assert.equal(op.effectUnknown, true, "已消费被中止 = 效果未知");
    assert.ok(h.svc.stopOps().length >= 1, "停止路径调用 helper stop-op（calls.log）");
    assert.ok(rt.store.getConfirmation(conf.id)!.consumedAt, "批准已消费");
    // 覆盖点 18：中断产物保持 partial，artifactIds 已接到 task.tool_result 事件
    const results = toolResults(rt, conf.taskId);
    assert.ok(results.some((e: any) => (e.artifactIds ?? []).length > 0), "tool_result 事件带产物引用");
    const arts = rt.store.listArtifactsByTask(conf.taskId);
    assert.ok(
      arts.some((a) => a.status === "partial" && a.name.startsWith("service-restart")),
      `中断的 restart 产物保持 partial（实际：${arts.map((a) => `${a.name}:${a.status}`).join(",")}）`,
    );
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("取消：停止查询失败时占用保留（无法确认退出，不释放）（覆盖点 16c）", async () => {
  const h = await imHarness("svc-cancel-unreaped", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    h.svc.touch("restart-delay-ms", "2500");
    h.svc.touch("stop-query-fails");
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    h.api.push({ text: `/approve ${conf.id} ${conf.permissionVersion}` });
    await waitFor("restart 已在途（delay 中）", () => h.svc.restarts().length === 1);
    await rt.interruptTask(conf.taskId);
    await waitFor("任务中断", () => rt.store.getTask(conf.taskId)!.status === "interrupted");
    assert.ok(h.svc.stopOps().length >= 1, "停止路径调用了 stop-op（应答 exited:false）");
    assert.ok(
      rt.store.listAllOccupancy().some((o) => o.taskId === conf.taskId),
      "无法确认退出：占用保留",
    );
    assert.ok(taskEvents(rt, conf.taskId, "task.tool_process_unreaped").length >= 1, "占用保留有事件证据");
    assert.equal(h.svc.starts(), 1);
    assert.equal(rt.store.getToolOp(conf.toolOpId)!.effectUnknown, true);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});
