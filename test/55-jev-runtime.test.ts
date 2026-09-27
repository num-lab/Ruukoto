/**
 * Jev 筛选接入模型上下文组装（经模块接口，不起 Runtime；Jev 为本地 HTTP 模拟）：
 * 默认零调用、筛选只影响取舍、失败与等待期间的变化回退基础规则、取消立即中止。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { ContextSendBlocked } from "../src/agent/context-assembly.ts";
import { JEV_MODEL } from "../src/agent/jev.ts";
import { jevConfigKey, JEV_CREDENTIAL_PURPOSE } from "../src/agent/jev-config.ts";
import { startAssemblyKit, waitFor } from "./helpers/testkit.ts";

const SECRET = "jev-test-private-key";

let clock = Date.parse("2026-09-27T00:00:00.000Z");
const user = (text: string) => ({ role: "user", content: text, timestamp: clock++ });
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: clock++ });

function answer(body: any, res: http.ServerResponse, keep: (question: any) => boolean = () => true): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    model: JEV_MODEL,
    answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, { type: "noul", noul: keep(question) ? 0.9 : 0.1 }])),
    usage: { input_tokens: 100, output_tokens: 10 },
  }));
}

async function startJev(handler: (body: any, res: http.ServerResponse) => void = answer) {
  const hits: any[] = [];
  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      hits.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    hits, host, url: `http://${host}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Kit = Awaited<ReturnType<typeof startAssemblyKit>>;

/** 拥有者启用 Jev 后的持久状态：凭据限定本项目与 jev_context 用途，配置版本递增。 */
function enable(kit: Kit, projectId: string, host: string, secret = SECRET): void {
  kit.deps.credentials.upsert({
    name: "jev-test", host, header: "authorization", purpose: JEV_CREDENTIAL_PURPOSE, secret,
    scope: { projectId, operations: [JEV_CREDENTIAL_PURPOSE] },
  });
  kit.store.setMetaValue(jevConfigKey(projectId), JSON.stringify({ enabled: true, credential: "jev-test", configVersion: 1 }));
}

function disable(kit: Kit, projectId: string): void {
  kit.store.setMetaValue(jevConfigKey(projectId), JSON.stringify({ enabled: false, credential: "jev-test", configVersion: 2 }));
}

test("Jev：默认零调用，筛选影响发送视图，关闭后恢复基础规则", async () => {
  const jev = await startJev((body, res) => answer(body, res, (q) => q.instructions.includes("蓝色灯塔")));
  const kit = await startAssemblyKit("jev-flow");
  kit.deps.jev = { baseUrl: jev.url };
  try {
    const { projectId, session } = kit.project();
    const history = [user("暗号是蓝色灯塔"), reply("已记录"), user("临时闲聊橙色风筝"), reply("已记录")];
    const run = (input: string) => kit.send(kit.begin(kit.task(session, input), session), [...history, user(input)]);

    const off = await run("请找回已确认暗号");
    assert.equal(jev.hits.length, 0);
    assert.equal(off.record.experiment, null);

    enable(kit, projectId, jev.host);
    const { view, record } = await run("请找回已确认暗号");
    assert.equal(jev.hits.length, 1);
    assert.equal(record.strategy, "jev-v1");
    assert.equal(record.experiment?.status, "applied");
    assert.equal(record.experiment?.usage?.inputTokens, 100);
    assert.equal(record.usage?.cacheRead, 0);
    assert.equal(record.usage?.cost?.total, 0, "保存 mock 模型明确配置的零单价，不影响独立 Jev 费用");
    assert.ok(record.excluded.some((item) => item.reason.includes("jev")));
    const sent = JSON.stringify(view);
    assert.ok(sent.includes("蓝色灯塔"));
    assert.ok(!sent.includes("橙色风筝"));
    assert.ok(!JSON.stringify(record).includes(SECRET));

    disable(kit, projectId);
    const disabled = await run("恢复基础规则");
    assert.equal(jev.hits.length, 1);
    assert.equal(disabled.record.strategy, "deterministic-v1");
    assert.equal(disabled.record.experiment, null);
    assert.ok(JSON.stringify(disabled.view).includes("橙色风筝"));
  } finally {
    await kit.close();
    await jev.close();
  }
});

test("Jev：HTTP 错误和超时回退相同基础选择，缺凭据不发请求", async () => {
  let hang = false;
  const jev = await startJev((_body, res) => { if (!hang) res.writeHead(529).end(SECRET); });
  const kit = await startAssemblyKit("jev-fallback");
  kit.deps.jev = { baseUrl: jev.url, timeoutMs: 100 };
  try {
    const { projectId, session } = kit.project();
    const run = (input: string) => kit.send(kit.begin(kit.task(session, input), session), [user("保留历史事实"), reply("完成"), user(input)]);
    enable(kit, projectId, jev.host);
    for (const reason of ["http_529", "timeout"]) {
      const { record } = await run(`错误回退 ${reason}`);
      assert.equal(record.strategy, "deterministic-v1");
      assert.equal(record.experiment?.fallbackReason, reason);
      assert.deepEqual(record.includedIndices, record.experiment?.baselineIncludedIndices);
      assert.equal(record.experiment?.estimatedCost, null, "失败且未知 usage 不能声称零费用");
      assert.ok(!JSON.stringify(record).includes(SECRET));
      hang = true;
    }
    assert.equal(jev.hits.length, 2, "每次调用最多发一个请求");
    kit.deps.credentials.remove("jev-test");
    const missing = (await run("删除凭据后继续")).record;
    assert.equal(jev.hits.length, 2);
    assert.equal(missing.experiment?.requestSent, false);
    assert.equal(missing.strategy, "deterministic-v1");
  } finally {
    await kit.close();
    await jev.close();
  }
});

test("Jev：中止立即结束筛选，不留选择也不落记录；迟到结果不影响下一任务", async () => {
  let release = () => {};
  const jev = await startJev((body, res) => { release = () => answer(body, res); });
  const kit = await startAssemblyKit("jev-cancel");
  kit.deps.jev = { baseUrl: jev.url };
  try {
    const { projectId, session } = kit.project();
    const history = [user("可选历史"), reply("完成")];
    enable(kit, projectId, jev.host);
    const task = kit.task(session, "取消筛选中的任务");
    const assembly = kit.begin(task, session);
    const messages = [...history, user("取消筛选中的任务")];
    const pending = assembly.assemble(messages, kit.sdk());
    await waitFor("Jev 已收到请求", () => jev.hits.length === 1);
    assembly.abort();
    const settled = await Promise.race([pending, new Promise((r) => setTimeout(r, 5_000, "still-waiting").unref())]);
    assert.equal(settled, undefined, "中止即结束等待（未放行 Jev 响应），不交出视图");
    const events = kit.store.getEventsAfter(0).filter((event) => event.taskId === task.id && event.body.type === "task.context_experiment");
    assert.equal(events.length, 1);
    assert.equal((events[0]!.body as any).experiment.status, "canceled");
    assert.throws(() => assembly.prepareSend(kit.model, { systemPrompt: "sys", messages, tools: [] }, {}),
      (err: any) => err instanceof ContextSendBlocked && err.code === "context_selection_missing");
    assert.equal(kit.store.listSelectionRecordsByTask(task.id).length, 0);
    release();
    disable(kit, projectId);
    const next = await kit.send(kit.begin(kit.task(session, "取消之后的新任务"), session), [...messages, user("取消之后的新任务")]);
    assert.equal(next.record.experiment, null);
  } finally {
    await kit.close();
    await jev.close();
  }
});

for (const change of ["disable", "credential", "credential_rotation"] as const) {
  test(`Jev：等待期间 ${change} 后丢弃远端结果并按基础规则继续`, async () => {
    let release = () => {};
    const jev = await startJev((body, res) => { release = () => answer(body, res, () => false); });
    const kit = await startAssemblyKit(`jev-revoke-${change}`);
    kit.deps.jev = { baseUrl: jev.url };
    try {
      const { projectId, session } = kit.project();
      enable(kit, projectId, jev.host);
      const sending = kit.send(kit.begin(kit.task(session, `等待 ${change} 变更`), session),
        [user("不能丢弃的旧历史"), reply("完成"), user(`等待 ${change} 变更`)]);
      await waitFor("Jev 在途", () => jev.hits.length === 1);
      if (change === "disable") disable(kit, projectId);
      else if (change === "credential") kit.deps.credentials.remove("jev-test");
      else enable(kit, projectId, jev.host, `${SECRET}-rotated`);
      release();
      const { view, record } = await sending;
      assert.equal(record.experiment?.fallbackReason, "config_or_credential_changed");
      assert.equal(record.experiment?.status, "fallback");
      assert.deepEqual(record.includedIndices, record.experiment?.baselineIncludedIndices);
      assert.ok(JSON.stringify(view).includes("不能丢弃的旧历史"));
    } finally {
      await kit.close();
      await jev.close();
    }
  });
}

test("Jev：等待期间撤销记忆及跨项目资料授权，发送视图重新核实", async () => {
  let release = () => {};
  const jev = await startJev((body, res) => { release = () => answer(body, res); });
  const kit = await startAssemblyKit("jev-memory", { workDirs: 2 });
  kit.deps.jev = { baseUrl: jev.url };
  try {
    const a = kit.project(kit.work[0]);
    const b = kit.project(kit.work[1]);
    const history = [user("当前项目历史" + "甲".repeat(800)), reply("完成")];
    const seed = (await kit.send(kit.begin(kit.task(a.session, "种子"), a.session), history.slice(0, 1))).record;
    const taskB = kit.task(b.session, "来源项目历史");
    const artifact = kit.deps.artifacts.begin({ taskId: taskB.id, sessionId: b.session.id, name: "source" });
    kit.deps.artifacts.append(artifact.id, Buffer.from("来源原文"));
    kit.deps.artifacts.complete(artifact.id);
    const grant = kit.deps.access.createGrant({ fromProjectId: b.projectId, toProjectId: a.projectId, category: "artifact" });
    const shared = kit.deps.memories.create({
      projectId: a.projectId, category: "decision", content: "等待中撤销来源的机密记忆",
      sourceRefs: [{ kind: "artifact", artifactId: artifact.id }], author: "owner",
    });
    const own = kit.deps.memories.create({
      projectId: a.projectId, category: "preference", content: "等待中停用的个人偏好" + "乙".repeat(600),
      sourceRefs: [{ kind: "owner_note", note: "测试记录" }], author: "owner",
    });
    // 使旧历史只在撤销记忆释放预算后装得下，能识别使用等待前基线的错误。
    kit.deps.budgetOverrides = { contextWindow: seed.estimatedTotal + (seed.windowSnapshot!.contextWindow - seed.budget) + 400 };
    enable(kit, a.projectId, jev.host);
    const sending = kit.send(kit.begin(kit.task(a.session, "检查当前资料范围"), a.session), [...history, user("检查当前资料范围")]);
    await waitFor("Jev 等待响应", () => jev.hits.length === 1);
    kit.deps.access.revokeGrant(grant.id);
    kit.deps.memories.revoke({ memoryId: own.id, expectedVersion: 1, author: "owner" });
    release();
    const { view, record } = await sending;
    const sent = JSON.stringify(view);
    assert.ok(!sent.includes("机密记忆"));
    assert.ok(!sent.includes("个人偏好"));
    assert.ok(record.excludedMemories.some((item) => item.memoryId === shared.id && item.reason === "source_scope_revoked"));
    assert.ok(sent.includes("当前项目历史"));
    assert.deepEqual(record.includedIndices, record.experiment?.baselineIncludedIndices, "全保留回答与基础规则使用同一份撤销后的输入");
    assert.ok(!JSON.stringify(jev.hits).includes("机密记忆"), "记忆不发送 Jev");
    assert.equal(kit.deps.memories.getMemory(shared.id)!.currentVersion, 1, "选择不得修订记忆");
    assert.equal(kit.deps.artifacts.read(artifact.id, 0, 100).toString("utf8"), "来源原文");
  } finally {
    await kit.close();
    await jev.close();
  }
});

test("Jev：主模型失败的默认全零用量保持未知，Jev 已知用量独立保留", async () => {
  const jev = await startJev();
  const kit = await startAssemblyKit("jev-model-failure");
  kit.deps.jev = { baseUrl: jev.url };
  try {
    const { projectId, session } = kit.project();
    enable(kit, projectId, jev.host);
    // SDK 在失败响应上也填全零 usage
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const { record } = await kit.send(kit.begin(kit.task(session, "主模型失败"), session), [user("保存历史"), reply("完成"), user("主模型失败")], { usage: zero });
    assert.equal(record.usage, null);
    assert.equal(record.experiment?.usage?.inputTokens, 100);
    assert.equal(record.experiment?.requestSent, true);
  } finally {
    await kit.close();
    await jev.close();
  }
});
