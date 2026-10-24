import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { listAgentReports, listAgentWaits } from "@ruukoto/core/agent-wait.ts";
import { getWorkflowQuestion, listWorkflowExecutions, listWorkflowRuns, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { waitFor } from "./helpers/testkit.ts";

interface ProviderConfig { baseUrl: string; models: { id: string }[]; [key: string]: unknown }

function safeError(error: unknown, depth = 0): { name: string; code: string | null; cause?: ReturnType<typeof safeError> } {
  if (!(error instanceof Error)) return { name: "NonError", code: null };
  const code = "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : null;
  return { name: /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : "Error", code, ...(depth < 3 && error.cause ? { cause: safeError(error.cause, depth + 1) } : {}) };
}

/** 真实请求与响应原样转发；只延后第二个子任务已经收到的真实响应，固定拥有者输入的竞态时序。 */
async function gateRealChildResponse(target: string) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let gated = false, remoteReceived = false;
  const proxy = http.createServer((request, response) => {
    let stage = "read_request";
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), parsed = (body.length ? JSON.parse(body.toString("utf8")) : {}) as { messages?: unknown[]; input?: unknown[]; tools?: { name?: string; function?: { name?: string } }[] };
      const child = !gated && JSON.stringify(parsed.messages ?? parsed.input ?? []).includes("WAIT_CHILD_SECOND") && !parsed.tools?.some(tool => (tool.function?.name ?? tool.name) === "wait");
      if (child) gated = true;
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value && !["host", "connection", "content-length", "transfer-encoding"].includes(key)) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      stage = "forward";
      const upstream = await fetch(new URL(request.url!, new URL(target).origin), { method: request.method, headers, ...(body.length ? { body } : {}) });
      stage = "read_response";
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (child && upstream.ok) { remoteReceived = true; await gate; }
      const resultHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => { if (!["content-length", "content-encoding", "transfer-encoding"].includes(key)) resultHeaders[key] = value; });
      stage = "write_response";
      response.writeHead(upstream.status, resultHeaders); response.end(bytes);
    })().catch(error => {
      process.stderr.write("[ruukoto:agent-wait-model-proxy] " + JSON.stringify({ stage, error: safeError(error) }) + "\n");
      response.writeHead(502); response.end("真实模型代理转发失败");
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address(); assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}${new URL(target).pathname.replace(/\/$/, "")}`, release,
    received: () => remoteReceived, close: async () => { release(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); } };
}

test("真实模型门控代理支持 Responses 输入与扁平工具名，仅暂扣子任务的完整响应", { timeout: 10_000 }, async () => {
  const bodies: string[] = [];
  const upstream = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks).toString("utf8")); response.writeHead(200); response.end("远端完整响应");
    })().catch(() => { response.writeHead(500); response.end("HTTP 回归夹具读取失败"); });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const proxy = await gateRealChildResponse(`http://127.0.0.1:${address.port}/v1`);
  try {
    const discovery = await fetch(proxy.baseUrl + "/models");
    assert.equal(discovery.status, 200); assert.equal(await discovery.text(), "远端完整响应");
    const body = JSON.stringify({ input: [{ role: "user", content: "WAIT_CHILD_SECOND" }], tools: [{ type: "function", name: "wait" }] });
    const parent = await fetch(proxy.baseUrl + "/responses", { method: "POST", body });
    assert.equal(parent.status, 200); assert.equal(await parent.text(), "远端完整响应"); assert.equal(proxy.received(), false);
    const childBody = JSON.stringify({ input: [{ role: "user", content: "WAIT_CHILD_SECOND" }], tools: [] });
    const child = fetch(proxy.baseUrl + "/responses", { method: "POST", body: childBody });
    await waitFor("Responses 子任务完整响应已暂扣", proxy.received, 1000);
    proxy.release(); assert.equal(await (await child).text(), "远端完整响应");
    assert.deepEqual(bodies, ["", body, childBody], "模型发现与真实协议的正文逐字转发");
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

for (const product of [codeProduct.runtime]) test(`${product.type} 真实模型：主动等待后查询结果，第二次等待被拥有者输入打断且后台唯一补报`, { skip: process.env.RUN_MODEL_CHECK !== "1", timeout: 480_000 }, async () => {
  const file = process.env.RUN_WORKFLOW_MODELS_FILE;
  assert.ok(file, "真实等待验收必须显式指定 RUN_WORKFLOW_MODELS_FILE");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { providers: Record<string, ProviderConfig> };
  const candidates = Object.entries(raw.providers).flatMap(([provider, value]) => value.models.filter(model => model.id.includes("deepseek")).map(model => ({ provider, model, value })));
  const selected = candidates.find(candidate => candidate.provider === "deepseek" && candidate.model.id.includes("flash")) ?? candidates[0];
  assert.ok(selected, "指定配置没有 DeepSeek 模型");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-agent-wait-model-")), agentDir = path.join(root, "agent"), workspace = path.join(root, "work");
  fs.mkdirSync(agentDir); fs.mkdirSync(workspace);
  const proxy = await gateRealChildResponse(selected.value.baseUrl);
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [selected.provider]: { ...selected.value, baseUrl: proxy.baseUrl, models: [selected.model] } } }), { mode: 0o600 });
  let rt: Runtime | null = null, passed = false;
  try {
    rt = await Runtime.start({ product, agentDir, dataDir: path.join(root, "data"), socketPath: path.join(root, "c.sock"), modelProvider: selected.provider,
      modelId: selected.model.id, thinkingLevel: "off", qqDisabled: true });
    const runtime = rt;
    const session = product.type === "ruukoto-code" ? await rt.createSession({ projectName: "real-wait", cwd: workspace }) : rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "full_access" });
    const firstDefinition = await rt.saveWorkflowDefinition({ name: "wait-first", script: 'return await agent("result",{request:"只回复 WAIT_RESULT_FIRST，不调用工具。",tools:[]});', expectedDigest: null, requestKey: "save-first" });
    const secondDefinition = await rt.saveWorkflowDefinition({ name: "wait-second", script: 'await ask("hold",{prompt:"继续第二项真实等待验收？",options:["yes"]}); return await agent("result",{request:"只回复 WAIT_CHILD_SECOND，不调用工具。",tools:[]});', expectedDigest: null, requestKey: "save-second" });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", modelSelection: rt.defaultSelection, input: "这是工具执行验收，请严格按以下顺序完成，不提前回复：先 workflow_instructions；workflow_start 启动 name=wait-first,input=null,key=first；对返回的 run_id 调用 wait，timeout_ms=300000。收到 result 后必须 workflow_query(part=run,run_id=第一项ID) 核实第一项成功。然后 workflow_start 启动 name=wait-second,input=null,key=second；对第二项 run_id 调用 wait，timeout_ms=300000。如果返回 attention，宿主会回答人工问题，你必须立即再次 wait 同一项，timeout_ms=300000。直到第二项结果返回才总结；不要用查询轮询代替等待，不执行其他业务工具。" });
    const healthy = () => {
      const task = runtime.store.getTask(parent.id)!;
      assert.ok(!["failed", "canceled", "interrupted", "completed"].includes(task.status), JSON.stringify({ status: task.status, error: task.errorMessage }));
      return task;
    };
    await waitFor("真实父模型消费第一结果并核实，第二项进入 attention", () => {
      healthy();
      const second = listWorkflowRuns(runtime.store).find(run => run.definitionId === secondDefinition.id);
      return !!second && getWorkflowQuestion(runtime.store, second.id, "hold")?.status === "pending" && listAgentWaits(runtime.store, { taskId: parent.id }).some(wait => wait.reason === "attention");
    }, 180_000);
    const first = listWorkflowRuns(rt.store).find(run => run.definitionId === firstDefinition.id)!, second = listWorkflowRuns(rt.store).find(run => run.definitionId === secondDefinition.id)!;
    const firstWait = listAgentWaits(rt.store, { taskId: parent.id }).find(wait => wait.targets.some(target => target.kind === "workflow" && target.runId === first.id))!;
    assert.equal(firstWait.reason, "result"); assert.equal(requireWorkflowRun(rt.store, first.id).status, "succeeded");
    assert.ok(rt.store.listToolOpsByTask(parent.id).some(op => op.toolName === "workflow_query" && op.isError === false && op.params.run_id === first.id), "真实父模型取得结果后实际查询核实");
    const firstConsumption = listAgentReports(rt.store).find(item => item.target.kind === "workflow" && item.target.runId === first.id)!.consumption;
    assert.equal(firstConsumption?.taskId, parent.id);
    const question = getWorkflowQuestion(rt.store, second.id, "hold")!;
    rt.answerWorkflowQuestion({ runId: second.id, stepKey: "hold", runVersion: question.runVersion, version: question.version, requestKey: "answer", answer: "yes" });
    await waitFor("第二子任务真实响应门控期间，父模型再次持久等待", () => {
      healthy();
      return proxy.received() && listAgentWaits(runtime.store, { taskId: parent.id }).some(wait => wait.phase === "waiting" && wait.targets.some(target => target.kind === "workflow" && target.runId === second.id));
    }, 180_000);
    const waiting = listAgentWaits(rt.store, { taskId: parent.id }).find(wait => wait.phase === "waiting")!;
    const owner = await rt.submit({ sessionId: session.id, requestId: "owner-next", modelSelection: rt.defaultSelection, input: "现在由拥有者追加新输入。请只回复 OWNER_INPUT_OK，不调用工具；原后台工作保持继续。" });
    await waitFor("真实新输入完成，旧父轮中断", () => runtime.store.getTask(owner.id)?.status === "completed" && runtime.store.getTask(parent.id)?.status === "interrupted", 120_000);
    assert.equal(listAgentWaits(rt.store, { taskId: parent.id }).find(wait => wait.id === waiting.id)!.reason, "owner_input");
    assert.match(rt.readTaskReply(owner.id)!.text, /OWNER_INPUT_OK/);
    assert.equal(requireWorkflowRun(rt.store, second.id).status, "running", "新输入不取消后台执行");
    proxy.release();
    await waitFor("后台真实响应继续并完成唯一补报", () => requireWorkflowRun(runtime.store, second.id).delivery?.status === "reported", 180_000);
    const final = requireWorkflowRun(rt.store, second.id), report = listAgentReports(rt.store).find(item => item.target.kind === "workflow" && item.target.runId === second.id)!;
    const firstReport = listAgentReports(rt.store).find(item => item.target.kind === "workflow" && item.target.runId === first.id)!;
    assert.equal(final.status, "succeeded"); assert.equal(report.status, "reported"); assert.ok(report.proof?.entryId);
    assert.equal(firstReport.status, "reported"); assert.deepEqual(firstReport.proof, report.proof, "中断父轮的两项结果共用唯一最终总结");
    assert.deepEqual(firstReport.consumption, firstConsumption, "已消费第一结果保留原父轮与原条目归属");
    assert.equal(report.consumption?.taskId, report.proof!.taskId);
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => task.status === "completed" && rt!.getTaskDetail(task.id)!.task.inputPurpose === "internal_report").length, 1);
    assert.ok(rt.readTaskReply(report.proof!.taskId)!.text.trim());
    const evidence = { product: product.type, provider: selected.provider, model: selected.model.id, sessionKind: product.type === "ruukoto" ? "main" : "dev", parentTaskId: parent.id,
      waits: listAgentWaits(rt.store, { taskId: parent.id }).map(wait => ({ id: wait.id, phase: wait.phase, reason: wait.reason, targets: wait.targets })),
      toolOps: rt.store.listToolOpsByTask(parent.id).map(op => ({ tool: op.toolName, isError: op.isError, effectUnknown: op.effectUnknown })),
      childTasks: listWorkflowExecutions(rt.store, second.id).map(execution => ({ taskId: execution.taskId, status: execution.status, stopVerified: execution.stopVerified })),
      ownerReply: rt.readTaskReply(owner.id)!.text, reports: [firstReport, report].map(item => ({ key: item.key, consumption: item.consumption, status: item.status, proof: item.proof })),
      summary: rt.readTaskReply(report.proof!.taskId)!.text };
    fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    process.stdout.write("[ruukoto:agent-wait-model] " + JSON.stringify(evidence) + "\n");
    passed = true;
  } finally {
    proxy.release(); if (rt) await rt.stop("model_agent_wait_end"); await proxy.close();
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`[ruukoto:agent-wait-model] 验收失败，保留隔离档案 ${root}\n`);
  }
});
