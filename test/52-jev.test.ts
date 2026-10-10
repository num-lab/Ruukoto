import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createHash } from "node:crypto";
import {
  DEFAULT_BUDGET_CONFIG, estimateMessageTokens, getContextCandidates, selectContext,
  type ContextCandidate, type SelectorInput,
} from "@ruukoto/agent/context-selector.ts";
import {
  evaluateJev, JevError, JEV_MODEL, JEV_CREDENTIAL_PURPOSE, JEV_INPUT_USD_PER_MILLION,
} from "@ruukoto/agent/jev.ts";

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 });
const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "package.json" } }], timestamp: 0 });
const result = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], timestamp: 0 });

function selectorInput(messages: any[], budget = 100_000): SelectorInput {
  return {
    messages, systemPrompt: "", tools: [], memories: [],
    budget: { ...DEFAULT_BUDGET_CONFIG, contextWindow: budget + 1, maxTokens: 1, thinkingBudget: 0,
      toolResultReserve: 0, safetyMargin: 0, memoryBudget: 0, calibration: 1 },
  };
}

function freeze(value: any): any {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

test("Jev 合成中文历史回放：旧事实重新进入视图，必留与工具配对完整，原消息不变", (t) => {
  const messages = [
    user("确认项目构建命令"), call("build"), result("build", "已确认构建命令：npm run build。"),
    user("记录临时天气"), assistant("今日天气与构建无关。".repeat(30)),
    user("找回已确认的构建命令"), call("earlier"), result("earlier", "较早尝试：读取无关目录。".repeat(20)),
    call("latest"), result("latest", "最新结果：正在查找 package.json。"),
  ];
  const original = JSON.stringify(messages);
  t.diagnostic(`jev-history-v1 sha256=${createHash("sha256").update(original).digest("hex")}`);
  freeze(messages);
  const wide = selectContext(selectorInput(messages));
  const oldTokens = messages.slice(0, 3).reduce((total, message) => total + estimateMessageTokens(message, 1), 0);
  const input = selectorInput(messages, wide.estimatedTotal - oldTokens);
  const baseline = selectContext(input);
  assert.deepEqual(baseline.includedIndices, [3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(selectContext(input, new Map()), baseline);
  const candidates = getContextCandidates(input);
  assert.deepEqual(candidates.map(({ id, indices }) => ({ id, indices })), [
    { id: "unit_6", indices: [6, 7] }, { id: "unit_3", indices: [3, 4] }, { id: "unit_0", indices: [0, 1, 2] },
  ]);
  const experiment = selectContext(input, new Map([["unit_6", false], ["unit_3", false], ["unit_0", true]]));
  assert.deepEqual(experiment.includedIndices, [0, 1, 2, 5, 8, 9]);
  assert.ok(experiment.estimatedTotal <= experiment.budget);
  assert.deepEqual(experiment.excluded.map(({ index }) => index), [3, 4, 6, 7]);
  assert.ok(experiment.excluded.every(({ reason }) => reason === "jev_rejected"));
  const calls = experiment.messages.flatMap((message) => message.role === "assistant"
    ? message.content.filter((part: any) => part.type === "toolCall").map((part: any) => part.id) : []);
  const results = experiment.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
  assert.deepEqual(calls, results);
  assert.equal(JSON.stringify(messages), original);
  assert.throws(() => selectContext(input, new Map([["unit_5", false]])), /无效候选/);
});

test("Jev 候选使用原序号，忽略孤儿消息；必留超预算仍失败，工具截断不改原文", () => {
  const messages: any[] = [user("旧请求"), assistant("旧回答"), user("当前请求"), call("orphan"), call("latest"), result("latest", "正文".repeat(5000))];
  freeze(messages);
  const input = selectorInput(messages);
  input.budget.toolResultViewChars = 4_000;
  assert.deepEqual(getContextCandidates(input).map(({ indices }) => indices), [[0, 1]]);
  const output = selectContext(input, new Map([["unit_0", false]]));
  assert.deepEqual(output.includedIndices, [2, 4, 5]);
  assert.deepEqual(output.droppedUnpaired, [{ index: 3, toolCallId: "orphan" }]);
  assert.equal(output.cappedToolResults.length, 1);
  assert.equal(messages[5]!.content[0].text.length, 10_000);
  assert.equal(selectContext(selectorInput(messages, 10), new Map([["unit_0", false]])).ok, false);
});

type MockHandler = (request: http.IncomingMessage, response: http.ServerResponse, body: any) => void;
async function mockServer(handler: MockHandler) {
  const requests: Array<{ path: string | undefined; headers: http.IncomingHttpHeaders; body: any; bytes: number }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    const body = JSON.parse(buffer.toString("utf8"));
    requests.push({ path: request.url, headers: request.headers, body, bytes: buffer.length });
    handler(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return {
    baseUrl, requests,
    credential: { host: new URL(baseUrl).host, header: "Authorization", purpose: JEV_CREDENTIAL_PURPOSE, secret: "test-secret" },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const candidates = (): ContextCandidate[] => [
  { id: "unit_0", indices: [0, 1, 2], messages: [user("查构建命令"), call("build"), result("build", "npm run build")] },
  { id: "unit_3", indices: [3, 4], messages: [user("天气"), assistant("晴天")] },
];
function responseFor(body: any, probability = 0.9): any {
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: probability }])),
    usage: { input_tokens: 1000, output_tokens: 20 } };
}

test("Jev HTTP：固定端点与 Noul 合约、概率阈值、用量和费用，元数据不含原文或密钥", async () => {
  const server = await mockServer((_request, response, body) => {
    const output = responseFor(body);
    output.answers.unit_0.noul = 0.5;
    output.answers.unit_3.noul = 0.49;
    response.end(JSON.stringify(output));
  });
  try {
    const output = await evaluateJev({ ...server, task: "找回已确认的构建命令", candidates: candidates() });
    assert.deepEqual([...output.decisions], [["unit_0", true], ["unit_3", false]]);
    assert.equal(server.requests.length, 1);
    const request = server.requests[0]!;
    assert.equal(request.path, "/v1/systemone");
    assert.equal(request.headers.authorization, "Bearer test-secret");
    assert.equal(request.body.model, JEV_MODEL);
    assert.deepEqual(request.body.state, { task: "找回已确认的构建命令" });
    assert.match(request.body.questions.unit_0.instructions, /toolCall build read/);
    assert.match(request.body.questions.unit_0.instructions, /npm run build/);
    assert.equal(output.metadata.requestSent, true);
    assert.deepEqual(output.metadata.usage, { inputTokens: 1000, outputTokens: 20 });
    assert.equal(output.metadata.estimatedCostUsd, 1000 * JEV_INPUT_USD_PER_MILLION / 1_000_000);
    assert.deepEqual(output.metadata.candidates, [
      { id: "unit_0", indices: [0, 1, 2], probability: 0.5 }, { id: "unit_3", indices: [3, 4], probability: 0.49 },
    ]);
    assert.doesNotMatch(JSON.stringify(output.metadata), /test-secret|npm run build|找回/);
  } finally { await server.close(); }
});

test("Jev HTTP：不完整文本或超限候选沿用基础规则，不发送 thinking、图片或 SDK details", async () => {
  const server = await mockServer((_request, response, body) => response.end(JSON.stringify(responseFor(body))));
  try {
    const list = candidates();
    list[0]!.messages[2].details = { secret: "hidden-details" };
    list.push(
      { id: "unit_5", indices: [5], messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private-thinking" }, { type: "text", text: "公开内容" }] }] },
      { id: "unit_6", indices: [6], messages: [{ role: "user", content: [{ type: "image", data: "private-image" }] }] },
      { id: "unit_7", indices: [7], messages: [user("超".repeat(9000))] },
      { id: "unit_8", indices: [8], messages: [{ role: "system", content: "private-system" }] },
    );
    const output = await evaluateJev({ ...server, task: "构建", candidates: list });
    assert.deepEqual([...output.decisions.keys()], ["unit_0", "unit_3"]);
    assert.equal(output.metadata.skippedCandidates, 4);
    assert.doesNotMatch(JSON.stringify(server.requests[0]!.body), /private-thinking|private-image|hidden-details|private-system/);
    assert.deepEqual(selectContext(selectorInput([user("旧"), assistant("答"), user("当前")]), new Map()),
      selectContext(selectorInput([user("旧"), assistant("答"), user("当前")])));
    const many = Array.from({ length: 50 }, (_, index) => ({ id: `unit_${index}`, indices: [index], messages: [user("候选".repeat(300))] }));
    const bounded = await evaluateJev({ ...server, task: "构建", candidates: many });
    assert.ok(bounded.metadata.evaluatedCandidates <= 24);
    assert.ok(bounded.metadata.skippedCandidates > 0);
    assert.ok(server.requests[1]!.bytes <= 24 * 1024);
  } finally { await server.close(); }
});

test("Jev HTTP：失败整次拒绝、零重试、错误脱敏", async (t) => {
  const cases: Array<{ name: string; code: string; send: MockHandler }> = [
    ...[401, 422, 429, 529].map((status) => ({ name: `HTTP ${status}`, code: `http_${status}`,
      send: ((_request, response) => { response.writeHead(status); response.end("test-secret 私人响应正文"); }) as MockHandler })),
    { name: "非法 JSON", code: "invalid_response", send: (_request, response) => response.end("test-secret 私人响应正文") },
    { name: "模型不符", code: "model_mismatch", send: (_request, response, body) => response.end(JSON.stringify({ ...responseFor(body), model: "other" })) },
    { name: "模型名回显密钥", code: "model_mismatch", send: (_request, response, body) => response.end(JSON.stringify({ ...responseFor(body), model: "test-secret" })) },
    { name: "缺失回答", code: "invalid_answers", send: (_request, response, body) => { const output = responseFor(body); delete output.answers.unit_0; response.end(JSON.stringify(output)); } },
    { name: "未知 ID", code: "invalid_answers", send: (_request, response, body) => { const output = responseFor(body); output.answers.unknown = output.answers.unit_0; response.end(JSON.stringify(output)); } },
    ...[-0.1, 1.1, "0.9", null].map((value) => ({ name: `非法概率 ${value}`, code: "invalid_answers",
      send: ((_request, response, body) => { const output = responseFor(body); output.answers.unit_0.noul = value; response.end(JSON.stringify(output)); }) as MockHandler })),
    { name: "错误回答类型", code: "invalid_answers", send: (_request, response, body) => { const output = responseFor(body); output.answers.unit_0.type = "boolean"; response.end(JSON.stringify(output)); } },
    { name: "非整数用量", code: "invalid_usage", send: (_request, response, body) => { const output = responseFor(body); output.usage.input_tokens = 1.5; response.end(JSON.stringify(output)); } },
    { name: "缺失用量", code: "invalid_usage", send: (_request, response, body) => { const output = responseFor(body); delete output.usage; response.end(JSON.stringify(output)); } },
    { name: "响应过大", code: "response_too_large", send: (_request, response) => response.end("x".repeat(70_000)) },
    { name: "重定向", code: "network_error", send: (_request, response) => { response.writeHead(302, { location: "/must-not-follow" }); response.end(); } },
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const server = await mockServer(sample.send);
    try {
      await assert.rejects(evaluateJev({ ...server, task: "构建", candidates: candidates() }), (error: any) => {
        assert.ok(error instanceof JevError);
        assert.equal(error.code, sample.code);
        assert.equal(error.metadata.requestSent, true);
        assert.ok(error.metadata.candidates.every((candidate: any) => candidate.probability === null));
        assert.doesNotMatch(JSON.stringify(error), /test-secret|私人响应正文/);
        assert.doesNotMatch(error.message, /test-secret|私人响应正文/);
        return true;
      });
      assert.equal(server.requests.length, 1);
    } finally { await server.close(); }
  });
});

test("Jev HTTP：请求前校验零发送，等待响应及正文时取消/超时均可中断", async (t) => {
  const server = await mockServer((_request, response, body) => response.end(JSON.stringify(responseFor(body))));
  try {
    const input = { ...server, task: "构建", candidates: candidates() };
    const canceled = new AbortController(); canceled.abort();
    const cases: Array<[string, Parameters<typeof evaluateJev>[0]]> = [
      ["canceled", { ...input, signal: canceled.signal }],
      ["invalid_endpoint", { ...input, baseUrl: "https://example.org" }],
      ["invalid_endpoint", { ...input, baseUrl: `${server.baseUrl}/different` }],
      ["invalid_credential", { ...input, credential: { ...input.credential, purpose: "other" } }],
      ["invalid_credential", { ...input, credential: { ...input.credential, host: "other" } }],
      ["invalid_credential", { ...input, credential: { ...input.credential, header: "x-secret" } }],
      ["invalid_timeout", { ...input, timeoutMs: 2001 }],
      ["request_too_large", { ...input, task: "中".repeat(9000) }],
      ["no_candidates", { ...input, candidates: [] }],
      ["invalid_candidates", { ...input, candidates: [candidates()[0]!, candidates()[0]!] }],
    ];
    for (const [code, value] of cases) await assert.rejects(evaluateJev(value), (error: any) => {
      assert.ok(error instanceof JevError); assert.equal(error.code, code); assert.equal(error.metadata.requestSent, false); return true;
    });
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
  for (const mode of ["timeout_headers", "timeout_body", "canceled"]) await t.test(mode, async () => {
    const controller = new AbortController();
    const server = await mockServer((_request, response) => {
      if (mode === "timeout_body") { response.writeHead(200); response.write("{"); }
      if (mode === "canceled") controller.abort();
    });
    try {
      await assert.rejects(evaluateJev({ ...server, task: "构建", candidates: candidates(), signal: controller.signal, timeoutMs: 40 }),
        (error: any) => { assert.ok(error instanceof JevError); assert.equal(error.code, mode === "canceled" ? "canceled" : "timeout"); return true; });
      assert.equal(server.requests.length, 1);
    } finally { await server.close(); }
  });
});
