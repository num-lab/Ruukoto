import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { waitFor } from "./helpers/testkit.ts";

test("真实模型后台：启动、browser访问、跨拥有者轮查日志、停止并恢复写入", {
  skip: process.env.RUN_MODEL_CHECK !== "1" ? "真实模型仅在 RUN_MODEL_CHECK=1 时执行" : false,
  timeout: 300_000,
}, async () => {
  const file = process.env.RUN_BACKGROUND_MODELS_FILE, binary = process.env.RUUKOTO_BROWSER_BINARY, chrome = process.env.RUUKOTO_BROWSER_CHROME;
  assert.ok(file, "须显式提供 RUN_BACKGROUND_MODELS_FILE");
  assert.ok(binary && path.isAbsolute(binary) && fs.existsSync(binary), "须提供固定官方 RUUKOTO_BROWSER_BINARY");
  assert.ok(chrome && path.isAbsolute(chrome) && fs.existsSync(chrome), "须提供 RUUKOTO_BROWSER_CHROME");
  let providers: Record<string, { models: { id: string }[]; [key: string]: unknown }>;
  try { providers = (JSON.parse(fs.readFileSync(file, "utf8")) as { providers: typeof providers }).providers; }
  catch { throw new Error("显式模型配置无法读取或解析；请核对文件，不输出凭据正文。"); }
  const requested = process.env.RUN_BACKGROUND_MODEL;
  const selected = Object.entries(providers).flatMap(([provider, config]) => config.models.map(model => ({ provider, config, model })))
    .find(item => requested ? `${item.provider}/${item.model.id}` === requested : item.provider === "deepseek");
  assert.ok(selected, "显式配置中没有所选模型；请指定 RUN_BACKGROUND_MODEL=provider/model");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-background-model-"))), agentDir = path.join(root, "agent"), workspace = path.join(root, "work");
  fs.mkdirSync(agentDir); fs.mkdirSync(workspace);
  const models = path.join(agentDir, "models.json");
  fs.writeFileSync(models, JSON.stringify({ providers: { [selected.provider]: { ...selected.config, models: [selected.model] } } }), { mode: 0o600 });
  let runtime: Runtime | undefined;
  const evidence: Record<string, unknown> = { status: "running", model: { provider: selected.provider, id: selected.model.id }, platform: process.platform, node: process.version, root };
  try {
    runtime = await Runtime.start({ product: product.runtime, dataDir: path.join(root, "data"), agentDir, socketPath: path.join(root, "c.sock"),
      modelProvider: selected.provider, modelId: selected.model.id, thinkingLevel: "off", browser: { binaryPath: binary, chromePath: chrome, headed: false } });
    const rt = runtime, selection = rt.defaultSelection;
    const session = await rt.createSession({ projectName: "background-model", cwd: workspace, mode: "full_access" });
    const script = "const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');const token=crypto.randomBytes(8).toString('hex');fs.writeFileSync('token',token);const s=http.createServer((q,r)=>{fs.appendFileSync('visits',q.url+'\\n');r.end('<title>后台验收</title><h1>网页短码 '+token+'</h1>')});s.listen(0,'127.0.0.1',()=>process.stdout.write('URL=http://127.0.0.1:'+s.address().port+'\\n'))";
    const command = `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
    const first = await rt.submit({ sessionId: session.id, requestId: "start", modelSelection: selection,
      input: `这是已授权的隔离验收。请仅用 process_start 启动以下命令（原样传command）：${JSON.stringify(command)}。随后通过 process_output 获取URL，用 browser 的 start、open、snapshot 实际访问该网页，并在最终回复给出页面短码。只可用 process_start/status/output 和 browser，不用bash、文件工具或其他工具。启动返回不等于HTTP已就绪，可查日志。完成后保持服务运行，结束本轮，下一轮再停止。` });
    const terminal = (id: string) => ["completed", "failed", "interrupted", "canceled"].includes(rt.store.getTask(id)!.status);
    await waitFor("真实模型启动及浏览完成", () => terminal(first.id), 130_000);
    assert.equal(rt.store.getTask(first.id)!.status, "completed", "真实启动轮未完成；请检查隔离档案");
    const firstOps = rt.store.listToolOpsByTask(first.id);
    evidence.firstOps = firstOps.map(op => ({ tool: op.toolName, isError: op.isError }));
    assert.equal(firstOps.filter(op => op.toolName === "process_start").length, 1);
    assert.ok(firstOps.every(op => ["process_start", "process_status", "process_output", "browser"].includes(op.toolName) && op.isError === false), "真实工具选择含错误或越界工具");
    assert.ok(firstOps.some(op => op.toolName === "browser" && op.params.action === "open"));
    assert.ok(firstOps.some(op => op.toolName === "browser" && op.params.action === "snapshot"));
    assert.equal(firstOps.find(op => op.toolName === "process_start")!.params.command, command);
    assert.ok(fs.existsSync(path.join(workspace, "visits")), "浏览器必须真实访问HTTP服务");
    assert.ok(rt.readTaskReply(first.id)!.text.includes(fs.readFileSync(path.join(workspace, "token"), "utf8")), "模型最终答复须含实际网页短码");
    const processId = rt.listBackgroundProcesses(session.id).processes[0].id;
    assert.equal(rt.listBackgroundProcesses(session.id).processes[0].state, "running");
    const second = await rt.submit({ sessionId: session.id, requestId: "next", modelSelection: selection,
      input: "这是下一条真实拥有者消息。查询本会话原后台的状态、stdout和stderr，报告仍在运行及日志观察。只使用process_status和process_output，保持后台运行后结束本轮。" });
    await waitFor("真实下一拥有者轮查询", () => terminal(second.id), 90_000);
    assert.equal(rt.store.getTask(second.id)!.status, "completed");
    const nextOps = rt.store.listToolOpsByTask(second.id);
    evidence.nextOps = nextOps.map(op => ({ tool: op.toolName, isError: op.isError }));
    assert.ok(nextOps.some(op => op.toolName === "process_status") && nextOps.some(op => op.toolName === "process_output"));
    assert.ok(nextOps.every(op => ["process_status", "process_output"].includes(op.toolName) && op.isError === false));
    assert.equal(rt.listBackgroundProcesses(session.id).processes[0].id, processId);
    const third = await rt.submit({ sessionId: session.id, requestId: "stop", modelSelection: selection,
      input: "现在停止本会话原后台，使用process_stop后用process_status核实stopped及stopVerified=true；未核实则报告，不写文件。核实成功后，使用write在当前目录创建acceptance.txt，内容准确为BACKGROUND_MODEL_OK。不要用bash，不重新启动服务。完成后结束本轮。" });
    await waitFor("真实停止和恢复写入", () => terminal(third.id), 90_000);
    assert.equal(rt.store.getTask(third.id)!.status, "completed");
    const stopOps = rt.store.listToolOpsByTask(third.id);
    evidence.stopOps = stopOps.map(op => ({ tool: op.toolName, isError: op.isError }));
    assert.ok(stopOps.some(op => op.toolName === "process_stop") && stopOps.some(op => op.toolName === "process_status") && stopOps.some(op => op.toolName === "write"));
    assert.ok(stopOps.every(op => ["process_stop", "process_status", "write"].includes(op.toolName) && op.isError === false));
    assert.equal(fs.readFileSync(path.join(workspace, "acceptance.txt"), "utf8"), "BACKGROUND_MODEL_OK");
    assert.equal(rt.listBackgroundProcesses(session.id).processes[0].stopVerified, true);
    assert.equal(rt.store.listAllOccupancy().length, 0);
    evidence.estimates = [first, second, third].map(task => rt.store.listSelectionRecordsByTask(task.id).map(record => record.estimates));
    evidence.status = "passed";
  } finally {
    await runtime?.stop("acceptance_end");
    fs.rmSync(models, { force: true });
    const evidenceFile = process.env.RUN_BACKGROUND_EVIDENCE_FILE ?? path.join(root, "result.json");
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(`[ruukoto:background-acceptance] 隔离证据 ${root}\n`);
  }
});
