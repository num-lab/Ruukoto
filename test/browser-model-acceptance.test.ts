import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ModelOption } from "@ruukoto/agent/model-selection.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product as personalProduct } from "./helpers/legacy-product.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { waitFor } from "./helpers/testkit.ts";

// Note: 见 .agents/notes/implemented/feature/2026-10-14-agent-browser.md
// 只读取显式模型配置；离线时不启动后台、浏览器或模型，不读取默认凭据目录。

interface AcceptanceModels {
  providers: Record<string, { models: Array<{ id: string; input?: string[] }>; [key: string]: unknown }>;
}

for (const product of [personalProduct.runtime, codeProduct.runtime]) test(`${product.type} 真实模型：截图读取 canvas 随机短码并通过浏览器唯一提交`, {
  skip: process.env.RUN_MODEL_CHECK !== "1" ? "真实模型仅在 RUN_MODEL_CHECK=1 时运行" : false,
  timeout: 240_000,
}, async () => {
  const file = process.env.RUN_BROWSER_MODELS_FILE;
  const binary = process.env.RUUKOTO_BROWSER_BINARY;
  const chrome = process.env.RUUKOTO_BROWSER_CHROME;
  assert.ok(file, "须显式指定 RUN_BROWSER_MODELS_FILE，不能使用拥有者默认凭据目录");
  assert.ok(binary && path.isAbsolute(binary) && fs.existsSync(binary), "须准备固定官方 release 原生程序并指定 RUUKOTO_BROWSER_BINARY 绝对路径");
  assert.ok(chrome && path.isAbsolute(chrome) && fs.existsSync(chrome), "须准备 Chromium 并指定 RUUKOTO_BROWSER_CHROME 绝对路径");
  let raw: AcceptanceModels;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) as AcceptanceModels; }
  catch {
    // JSON 解析异常可能含凭据正文；只报告显式配置失败。
    throw new Error("显式模型配置无法读取或解析，请核对 RUN_BROWSER_MODELS_FILE 的 JSON 内容");
  }
  const selected = Object.entries(raw.providers).flatMap(([provider, value]) => value.models
    .filter(model => model.input?.includes("image")).map(model => ({ provider, model, value })))[0];
  assert.ok(selected, "显式配置须含声明 input 包括 image 的视觉模型");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-browser-model-"));
  const agentDir = path.join(root, "agent"), workspace = path.join(root, "work");
  fs.mkdirSync(agentDir); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [selected.provider]: { ...selected.value, models: [selected.model] } } }), { mode: 0o600 });
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = [...randomBytes(6)].map(byte => alphabet[byte % alphabet.length]).join("");
  const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>浏览器视觉验收</title><style>body{margin:32px;font:20px sans-serif}canvas{display:block;margin:24px 0}input,button{font:20px sans-serif;padding:12px}</style><h1>只从截图读取短码</h1><canvas width="480" height="160" aria-label="图中有六位短码"></canvas><form action="/submit" method="post"><label>图中短码 <input name="code" maxlength="6" autocomplete="off" required></label><button type="submit">提交一次</button></form><script>const c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle='#f2f2f2';x.fillRect(0,0,c.width,c.height);x.fillStyle='#151515';x.font='bold 56px monospace';x.textAlign='center';x.textBaseline='middle';x.fillText(${JSON.stringify(code)},240,80);</script></html>`;
  let posts = 0, submitted = "", accepted = false;
  // 短码只画进 canvas；提交错误不回显正确答案，不能从 snapshot 或重试获得它。
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); return;
    }
    if (request.method !== "POST" || request.url !== "/submit") { response.writeHead(404); response.end(); return; }
    posts++;
    let body = "";
    request.setEncoding("utf8");
    request.on("error", () => { response.destroy(); });
    request.on("data", (chunk: string) => { body += chunk; if (Buffer.byteLength(body) > 1024) request.destroy(); });
    request.on("end", () => {
      submitted = new URLSearchParams(body).get("code") ?? "";
      accepted = submitted === code;
      response.writeHead(accepted ? 200 : 422, { "content-type": "text/html; charset=utf-8" });
      response.end(accepted ? "<p>提交已接受，请停止操作。</p>" : "<p>短码不符，请停止操作，不要再次提交。</p>");
    });
  });
  let rt: Runtime | null = null, passed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    rt = await Runtime.start({ product, agentDir, dataDir: path.join(root, "data"), socketPath: path.join(root, "c.sock"),
      modelProvider: selected.provider, modelId: selected.model.id, qqDisabled: true, toolFactory: () => [],
      browser: { binaryPath: binary, chromePath: chrome, headed: false, noSandbox: process.env.RUN_BROWSER_NO_SANDBOX === "1" } });
    let option: ModelOption | undefined;
    for (let offset = 0; ;) {
      const page = await rt.models.current.modelCatalog.list({ provider: selected.provider, offset });
      option = page.models.find(model => model.modelId === selected.model.id);
      if (option || page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    assert.ok(option?.available && option.thinkingLevels.length, "显式模型配置缺少可用认证或思考模式，不能记作验收通过");
    const selection = { ...rt.defaultSelection, thinkingLevel: option.thinkingLevels.includes("off") ? "off" as const : option.thinkingLevels[0] };
    const actualModel = await rt.models.current.modelCatalog.resolve(selection);
    assert.ok(actualModel.input.includes("image"), "SDK 实际模型必须支持图片，不能只依赖配置声明");
    const session = product.type === "ruukoto-code" ? await rt.createSession({ projectName: "browser-model", cwd: workspace }) : rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "full_access" });
    const task = await rt.submit({ sessionId: session.id, requestId: "visual-submit", modelSelection: selection,
      input: `仅使用 browser 工具完成真实视觉验收，不调用其他工具。先 start，再 open ${url}，然后 snapshot 获取输入框与提交按钮引用；canvas 中的六位短码不在快照文本里，必须 screenshot 看图读取。用 fill 将看见的六位原样填入输入框，再 click 提交按钮。提交只能一次，错误也不要重试。结束后 close 浏览器并简短回复完成。不要请求或读取网页源码。` });
    const runtime = rt;
    await waitFor("真实模型浏览器任务终态", () => {
      assert.ok(posts <= 1, "网页提交超过一次");
      return ["completed", "failed", "canceled", "interrupted"].includes(runtime.store.getTask(task.id)!.status);
    }, 180_000);
    assert.equal(rt.store.getTask(task.id)!.status, "completed", "真实任务未完成；检查保留的隔离档案");
    assert.equal(posts, 1, "服务端只接受一次提交尝试");
    assert.ok(accepted && submitted === code, "实际提交短码必须与随机 canvas 内容相同");
    const ops = rt.store.listToolOpsByTask(task.id);
    assert.ok(ops.length > 0 && ops.every(op => op.toolName === "browser" && op.isError === false && !op.effectUnknown), "全部实际调用须为成功且效果已核实的 browser 工具");
    const actions = ops.map(op => op.params.action);
    for (const action of ["start", "open", "snapshot", "screenshot", "fill", "click", "close"]) assert.ok(actions.includes(action), `实际工具缺少 ${action}`);
    assert.ok(actions.indexOf("screenshot") < actions.indexOf("fill") && actions.indexOf("fill") < actions.indexOf("click"), "模型须先看截图再填写提交");
    const firstFill = ops.findIndex(op => op.params.action === "fill");
    assert.ok(ops.slice(0, firstFill).filter(op => op.params.action === "snapshot").every(op => !op.resultSummary?.includes(code)), "填写前快照不能包含短码文本");
    const images = rt.store.listArtifactsByTask(task.id).filter(artifact => artifact.name === "browser-screenshot" && artifact.mimeType);
    assert.ok(images.length > 0, "截图须保存为不可变图片产物");
    const current = rt.store.getSession(session.id)!;
    assert.ok(current.sessionFile, "实际工具结果须进入会话记录");
    const history = fs.readFileSync(current.sessionFile, "utf8");
    const snapshots = rt.store.listSelectionRecordsByTask(task.id).filter(record => record.promptArtifactId).map(record => {
      const artifact = rt!.store.getArtifact(record.promptArtifactId!)!;
      return rt!.artifacts.read(artifact.id, 0, artifact.byteCount).toString("utf8");
    });
    for (const image of images) {
      assert.equal(image.status, "complete");
      const block = rt.artifacts.readImage(image.id, { taskId: task.id, sessionId: session.id });
      assert.equal(createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex"), image.contentHash);
      assert.ok(history.includes(block.data), "视觉块须能从 JSONL 重建");
      assert.ok(snapshots.some(snapshot => snapshot.includes(block.data)), "模型发送前的 prompt 快照必须包含实际视觉输入");
    }
    process.stdout.write(`[ruukoto:browser-model] ${product.type} task=${task.id} posts=${posts} images=${images.length} accepted=true\n`);
    passed = true;
  } finally {
    let stopped = false;
    try { if (rt) await rt.stop("browser_model_end"); stopped = true; }
    finally {
      if (!stopped) passed = false;
      if (server.listening) {
        const closing = new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
        server.closeAllConnections();
        await closing;
      }
      process.stderr.write(`[ruukoto:browser-model] 验收${passed ? "通过" : "未通过"}，保留隔离档案 ${root}\n`);
    }
  }
});
