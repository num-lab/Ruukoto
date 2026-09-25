import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import { JEV_MODEL } from "../src/agent/jev.ts";
import { createProjectSession, startTestRuntime, taskStatus, waitFor, type TestRuntime } from "./helpers/testkit.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;
const SECRET = "jev-test-private-key";

function reply(body: any, res: http.ServerResponse, keep: (question: any) => boolean = () => true): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    model: JEV_MODEL,
    answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, { type: "noul", noul: keep(question) ? 0.9 : 0.1 }])),
    usage: { input_tokens: 100, output_tokens: 10 },
  }));
}

async function startJev(handler: (body: any, res: http.ServerResponse) => void = reply) {
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

async function submit(t: TestRuntime, sessionId: string, input: string) {
  return t.client.request<any>("submit", {
    session_id: sessionId, input, request_id: input, model_selection: MODEL,
  });
}

async function completed(t: TestRuntime, task: { id: string }) {
  await waitFor(`任务 ${task.id} 结束`, async () =>
    ["completed", "failed", "interrupted", "canceled"].includes((await taskStatus(t.client, task.id)).task.status));
  const status = await taskStatus(t.client, task.id);
  assert.equal(status.task.status, "completed", status.task.errorMessage ?? status.task.interruptReason);
  return t.runtime.store.listSelectionRecordsByTask(task.id);
}

async function enable(t: TestRuntime, projectId: string, host: string) {
  await t.client.request("add_credential", {
    name: "jev-test", host, header: "authorization", purpose: "jev_context", secret: SECRET,
  });
  const config = await t.client.request<any>("get_project_jev", { project_id: projectId });
  return t.client.request<any>("set_project_jev", {
    project_id: projectId, enabled: true, credential: "jev-test", expected_version: config.configVersion,
  });
}

test("Jev 运行时：默认零调用，筛选影响实际请求，历史原文仍可查询，关闭后恢复基础规则", async () => {
  const jev = await startJev((body, res) => reply(body, res, (q) => q.instructions.includes("蓝色灯塔")));
  const t = await startTestRuntime("jev-flow", () => ({ kind: "text", text: "已记录" }), { config: { jev: { baseUrl: jev.url } } });
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const off = await completed(t, await submit(t, sessionId, "暗号是蓝色灯塔"));
    await completed(t, await submit(t, sessionId, "临时闲聊橙色风筝"));
    assert.equal(jev.hits.length, 0);
    assert.equal(off[0]!.experiment, null);
    const file = t.runtime.store.getSession(sessionId)!.sessionFile!;
    const original = fs.readFileSync(file);
    const config = await enable(t, projectId, jev.host);
    const records = await completed(t, await submit(t, sessionId, "请找回已确认暗号"));
    assert.equal(jev.hits.length, 1);
    const record = records[0]!;
    assert.equal(record.strategy, "jev-v1");
    assert.equal(record.experiment?.status, "applied");
    assert.equal(record.experiment?.usage?.inputTokens, 100);
    assert.equal(record.usage?.cacheRead, 0);
    assert.equal(record.usage?.cost?.total, 0, "保存 mock 模型明确配置的零单价，不影响独立 Jev 费用");
    assert.ok(record.excluded.some((item) => item.reason.includes("jev")));
    const actual = JSON.stringify(t.server.calls.at(-1)!.messages);
    assert.ok(actual.includes("蓝色灯塔"));
    assert.ok(!actual.includes("橙色风筝"));
    assert.deepEqual(fs.readFileSync(file).subarray(0, original.length), original, "原有 JSONL 字节必须保持原样，允许新任务追加");
    const found = await t.client.request<any>("search_history", { project_id: projectId, query: "橙色风筝" });
    assert.ok(found.hits.length > 0, "排除的原文可经历史查询找回");
    assert.ok(!JSON.stringify(records).includes(SECRET));
    await t.client.request("set_project_jev", { project_id: projectId, enabled: false, credential: "jev-test", expected_version: config.configVersion });
    const disabled = await completed(t, await submit(t, sessionId, "恢复基础规则"));
    assert.equal(jev.hits.length, 1);
    assert.equal(disabled[0]!.strategy, "deterministic-v1");
    assert.equal(disabled[0]!.experiment, null);
    assert.ok(JSON.stringify(t.server.calls.at(-1)!.messages).includes("橙色风筝"));
  } finally {
    await t.shutdown();
    await jev.close();
  }
});

test("Jev 运行时：HTTP 错误和超时回退相同基础选择，缺凭据不发请求", async () => {
  let hang = false;
  const jev = await startJev((_body, res) => { if (!hang) res.writeHead(529).end(SECRET); });
  const t = await startTestRuntime("jev-fallback", () => ({ kind: "text", text: "完成" }), {
    config: { jev: { baseUrl: jev.url, timeoutMs: 100 } },
  });
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await completed(t, await submit(t, sessionId, "保留历史事实"));
    await enable(t, projectId, jev.host);
    for (const reason of ["http_529", "timeout"]) {
      const records = await completed(t, await submit(t, sessionId, `错误回退 ${reason}`));
      const record = records[0]!;
      assert.equal(record.strategy, "deterministic-v1");
      assert.equal(record.experiment?.fallbackReason, reason);
      assert.deepEqual(record.includedIndices, record.experiment?.baselineIncludedIndices);
      assert.equal(record.experiment?.estimatedCost, null, "失败且未知 usage 不能声称零费用");
      assert.ok(!JSON.stringify(records).includes(SECRET));
      hang = true;
    }
    assert.equal(jev.hits.length, 2, "每次调用最多发一个请求");
    await t.client.request("remove_credential", { name: "jev-test" });
    const missing = await completed(t, await submit(t, sessionId, "删除凭据后继续"));
    assert.equal(jev.hits.length, 2);
    assert.equal(missing[0]!.experiment?.requestSent, false);
    assert.equal(missing[0]!.strategy, "deterministic-v1");
  } finally {
    await t.shutdown();
    await jev.close();
  }
});

test("Jev 运行时：取消立即中止筛选，迟到结果不触发主模型或污染下一任务", async () => {
  let release = () => {};
  const jev = await startJev((body, res) => { release = () => reply(body, res); });
  const t = await startTestRuntime("jev-cancel", () => ({ kind: "text", text: "完成" }), { config: { jev: { baseUrl: jev.url } } });
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await completed(t, await submit(t, sessionId, "可选历史"));
    const config = await enable(t, projectId, jev.host);
    const count = t.server.calls.length;
    const task = await submit(t, sessionId, "取消筛选中的任务");
    await waitFor("Jev 已收到请求", () => jev.hits.length === 1);
    await t.client.request("interrupt", { task_id: task.id });
    assert.equal((await taskStatus(t.client, task.id)).task.status, "interrupted");
    assert.equal(t.server.calls.length, count);
    const events = t.runtime.store.getEventsAfter(0).filter((event) => event.taskId === task.id && event.body.type === "task.context_experiment");
    assert.equal(events.length, 1);
    assert.equal((events[0]!.body as any).experiment.status, "canceled");
    assert.equal(t.runtime.store.listSelectionRecordsByTask(task.id).length, 0);
    release();
    await t.client.request("set_project_jev", { project_id: projectId, enabled: false, credential: "jev-test", expected_version: config.configVersion });
    await t.client.request("resume_queue", { session_id: sessionId });
    const next = await completed(t, await submit(t, sessionId, "取消之后的新任务"));
    assert.equal(t.server.calls.length, count + 1);
    assert.equal(next[0]!.experiment, null);
  } finally {
    await t.shutdown();
    await jev.close();
  }
});

for (const change of ["disable", "credential", "credential_rotation"] as const) {
  test(`Jev 运行时：等待期间 ${change} 后丢弃远端结果并按基础规则继续`, async () => {
    let release = () => {};
    const jev = await startJev((body, res) => { release = () => reply(body, res, () => false); });
    const t = await startTestRuntime(`jev-revoke-${change}`, () => ({ kind: "text", text: "完成" }), { config: { jev: { baseUrl: jev.url } } });
    try {
      const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
      await completed(t, await submit(t, sessionId, "不能丢弃的旧历史"));
      const config = await enable(t, projectId, jev.host);
      const task = await submit(t, sessionId, `等待 ${change} 变更`);
      await waitFor("Jev 在途", () => jev.hits.length === 1);
      if (change === "disable") {
        await t.client.request("set_project_jev", { project_id: projectId, enabled: false, credential: "jev-test", expected_version: config.configVersion });
      } else if (change === "credential") {
        await t.client.request("remove_credential", { name: "jev-test" });
      } else {
        await t.client.request("add_credential", {
          name: "jev-test", host: jev.host, header: "authorization", purpose: "jev_context", secret: `${SECRET}-rotated`,
        });
      }
      release();
      const record = (await completed(t, task))[0]!;
      assert.equal(record.experiment?.fallbackReason, "config_or_credential_changed");
      assert.equal(record.experiment?.status, "fallback");
      assert.deepEqual(record.includedIndices, record.experiment?.baselineIncludedIndices);
      assert.ok(JSON.stringify(t.server.calls.at(-1)!.messages).includes("不能丢弃的旧历史"));
    } finally {
      await t.shutdown();
      await jev.close();
    }
  });
}

test("Jev 运行时：等待期间撤销记忆及跨项目资料授权，发给主模型的前缀重新核实", async () => {
  let release = () => {};
  const jev = await startJev((body, res) => { release = () => reply(body, res); });
  const budgetOverrides = { contextWindow: 200_000 };
  const t = await startTestRuntime("jev-memory", () => ({ kind: "text", text: "完成" }), {
    config: { jev: { baseUrl: jev.url }, budgetOverrides },
  });
  try {
    const a = await createProjectSession(t.client, t.work[0]!);
    const b = await createProjectSession(t.client, t.work[1]!);
    const seed = (await completed(t, await submit(t, a.sessionId, "当前项目历史" + "甲".repeat(800))))[0]!;
    const taskB = await submit(t, b.sessionId, "来源项目历史");
    await completed(t, taskB);
    const artifact = t.runtime.artifacts.begin({ taskId: taskB.id, sessionId: b.sessionId, name: "source" });
    t.runtime.artifacts.append(artifact.id, Buffer.from("来源原文"));
    t.runtime.artifacts.complete(artifact.id);
    const grant = await t.client.request<any>("create_data_grant", { from_project_id: b.projectId, to_project_id: a.projectId, category: "artifact" });
    const shared = await t.client.request<any>("save_memory", {
      project_id: a.projectId, category: "decision", content: "等待中撤销来源的机密记忆",
      source_refs: [{ kind: "artifact", artifactId: artifact.id }],
    });
    const own = await t.client.request<any>("save_memory", {
      project_id: a.projectId, category: "preference", content: "等待中停用的个人偏好" + "乙".repeat(600),
      source_refs: [{ kind: "owner_note", note: "测试记录" }],
    });
    // 使旧历史只在撤销记忆释放预算后装得下，能识别使用等待前基线的错误。
    budgetOverrides.contextWindow = seed.estimatedTotal + (seed.windowSnapshot!.contextWindow - seed.budget) + 400;
    await enable(t, a.projectId, jev.host);
    const task = await submit(t, a.sessionId, "检查当前资料范围");
    await waitFor("Jev 等待响应", () => jev.hits.length === 1);
    await t.client.request("revoke_data_grant", { grant_id: grant.id });
    await t.client.request("revoke_memory", { memory_id: own.id, expected_version: 1 });
    release();
    const record = (await completed(t, task))[0]!;
    const actual = JSON.stringify(t.server.calls.at(-1)!.messages);
    assert.ok(!actual.includes("机密记忆"));
    assert.ok(!actual.includes("个人偏好"));
    assert.ok(record.excludedMemories.some((item) => item.memoryId === shared.id && item.reason === "source_scope_revoked"));
    assert.ok(actual.includes("当前项目历史"));
    assert.deepEqual(record.includedIndices, record.experiment?.baselineIncludedIndices, "全保留回答与基础规则使用同一份撤销后的输入");
    assert.ok(!JSON.stringify(jev.hits).includes("机密记忆"), "记忆不发送 Jev");
    assert.equal(t.runtime.memories.getMemory(shared.id)!.currentVersion, 1, "选择不得修订记忆");
    assert.equal(t.runtime.artifacts.read(artifact.id, 0, 100).toString("utf8"), "来源原文");
  } finally {
    await t.shutdown();
    await jev.close();
  }
});

test("Jev 运行时：主模型失败的默认全零用量保持未知，Jev 已知用量独立保留", async () => {
  let failModel = false;
  const jev = await startJev();
  const t = await startTestRuntime("jev-model-failure", () => {
    if (failModel) throw new Error("模拟主模型不可用");
    return { kind: "text", text: "完成" };
  }, { config: { jev: { baseUrl: jev.url } } });
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await completed(t, await submit(t, sessionId, "保存历史"));
    await enable(t, projectId, jev.host);
    failModel = true;
    const task = await submit(t, sessionId, "主模型失败");
    await waitFor("失败终态", async () => (await taskStatus(t.client, task.id)).task.status === "failed");
    const record = t.runtime.store.listSelectionRecordsByTask(task.id)[0]!;
    assert.equal(record.usage, null);
    assert.equal(record.experiment?.usage?.inputTokens, 100);
    assert.equal(record.experiment?.requestSent, true);
  } finally {
    await t.shutdown();
    await jev.close();
  }
});
