import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { afterTool, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

test("真实后台服务→后续browser工具访问→下一拥有者轮查询→显式停止", {
  skip: process.env.RUN_BACKGROUND_BROWSER_CHECK !== "1" ? "真实浏览器仅在 RUN_BACKGROUND_BROWSER_CHECK=1 时执行" : false,
  timeout: 120_000,
}, async () => {
  const binary = process.env.RUUKOTO_BROWSER_BINARY, chrome = process.env.RUUKOTO_BROWSER_CHROME;
  assert.ok(binary && path.isAbsolute(binary) && fs.existsSync(binary), "须显式指定固定官方 RUUKOTO_BROWSER_BINARY");
  assert.ok(chrome && path.isAbsolute(chrome) && fs.existsSync(chrome), "须显式指定 RUUKOTO_BROWSER_CHROME");
  let command = "", urlFile = "", phase = "start", step = 0, processId = "";
  const t = await startTestRuntime("background-browser", async request => {
    if (phase === "start") {
      if (step === 0) { step++; return { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command } }] }; }
      assert.ok(toolNamesOf(request).includes("browser"));
      assert.ok(!toolNamesOf(request).includes("write"));
      if (step === 1) { step++; return { kind: "tool_calls", calls: [{ id: "browser-start", name: "browser", arguments: { action: "start" } }] }; }
      if (step === 2) {
        step++; await waitFor("服务产生实际URL", () => fs.existsSync(urlFile));
        return { kind: "tool_calls", calls: [{ id: "open", name: "browser", arguments: { action: "open", url: fs.readFileSync(urlFile, "utf8") } }] };
      }
      if (step === 3) { step++; return { kind: "tool_calls", calls: [{ id: "snapshot", name: "browser", arguments: { action: "snapshot" } }] }; }
      return { kind: "text", text: "浏览器已实际访问本机服务" };
    }
    return afterTool(request) ? { kind: "text", text: "下一拥有者轮已查询" }
      : { kind: "tool_calls", calls: [{ id: "status-next", name: "process_status", arguments: { process_id: processId } }] };
  }, { workDirs: 1, config: { ...realTools(), product: product.runtime, browser: { binaryPath: binary, chromePath: chrome, headed: false } } });
  try {
    const session = await t.runtime.createSession({ projectName: "browser", cwd: t.work[0], mode: "full_access" });
    urlFile = path.join(t.work[0], "url");
    const script = `const fs=require('node:fs'),http=require('node:http');const s=http.createServer((q,r)=>{fs.appendFileSync('visits',q.url+'\\n');r.end('<title>BACKGROUND_BROWSER_OK</title><h1>真实后台页面</h1>')});s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(urlFile)},'http://127.0.0.1:'+s.address().port))`;
    command = `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
    const task = await t.runtime.submit({ sessionId: session.id, requestId: "start", input: "启动服务并浏览", modelSelection: t.runtime.defaultSelection });
    await waitFor("真实browser工具链结束", () => ["completed", "failed", "interrupted"].includes(t.runtime.store.getTask(task.id)!.status), 90_000);
    const ops = t.runtime.store.listToolOpsByTask(task.id);
    assert.equal(t.runtime.store.getTask(task.id)!.status, "completed", JSON.stringify(ops));
    assert.deepEqual(ops.map(op => op.toolName), ["process_start", "browser", "browser", "browser"]);
    assert.ok(ops.every(op => op.isError === false), JSON.stringify(ops));
    assert.match(fs.readFileSync(path.join(t.work[0], "visits"), "utf8"), /\//);
    const entries = parseSessionFile(t.runtime.store.getSession(session.id)!.sessionFile!);
    assert.match(JSON.stringify(entries), /真实后台页面/);
    processId = t.runtime.listBackgroundProcesses(session.id).processes[0].id;
    phase = "next";
    const next = await t.runtime.submit({ sessionId: session.id, requestId: "next", input: "下一轮查询后台", modelSelection: t.runtime.defaultSelection });
    await waitFor("下一拥有者轮查后台", () => t.runtime.store.getTask(next.id)!.status === "completed", 30_000);
    await t.runtime.stopBackgroundProcess({ sessionId: session.id, processId });
    await waitFor("显式停止核实完成", () => ["stopped", "stop_unverified"].includes(t.runtime.listBackgroundProcesses(session.id).processes[0].state), 20_000);
    assert.equal(t.runtime.listBackgroundProcesses(session.id).processes[0].state, "stopped", JSON.stringify(t.runtime.listBackgroundProcesses(session.id).processes[0]));
    assert.equal(t.runtime.store.listAllOccupancy().length, 0);
  } finally { await t.shutdown(); }
});
