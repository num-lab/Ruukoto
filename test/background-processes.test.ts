import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { listAgentWaits } from "@ruukoto/core/agent-wait.ts";
import { getBackgroundProcess, listActiveBackgroundProcesses } from "@ruukoto/core/background-processes.ts";
import { backgroundProcessForModel } from "@ruukoto/agent/background-process-tools.ts";
import { taskToolSet } from "@ruukoto/agent/tool-availability.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { afterTool, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

test("后台观测允许Plan查停但无启动和浏览资格，pending提问只保留状态与日志", () => {
  const names = ["process_start", "process_status", "process_output", "process_stop", "browser", "ask_user", "write", "agent_wait"];
  const tools = taskToolSet({ registered: names, plan: true, resourcePhase: "conversation", backgroundObservation: true,
    backgroundProcessesEnabled: true, backgroundStartEnabled: false, ownerQuestionsEnabled: true, browserEnabled: false, webSearchEnabled: true, mcpEffect: () => undefined });
  assert.deepEqual([...tools.allowed], ["process_status", "process_output", "process_stop", "ask_user"]);
  const pending = taskToolSet({ registered: names, plan: false, resourcePhase: "conversation", backgroundObservation: true,
    backgroundProcessesEnabled: true, backgroundStartEnabled: false, ownerQuestionPending: true, browserEnabled: true, webSearchEnabled: true, mcpEffect: () => undefined });
  assert.deepEqual([...pending.allowed], ["process_status", "process_output"]);
});

test("全新会话后台跨轮保留、交接即拒绝写入，停止核实后原轮重新取得目录", async () => {
  let command = "";
  let processId = "";
  let phase = "start";
  let step = 0;
  const t = await startTestRuntime("background-rounds", request => {
    if (phase === "start") {
      if (afterTool(request)) return { kind: "text", text: "后台已启动" };
      return { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command } },
        { id: "forbidden", name: "write", arguments: { path: "forbidden.txt", content: "禁止交接后写入" } }] };
    }
    if (phase === "restricted") {
      assert.ok(toolNamesOf(request).includes("process_status"));
      assert.ok(!toolNamesOf(request).includes("browser"));
      assert.ok(!toolNamesOf(request).includes("process_start"));
      return afterTool(request) ? { kind: "text", text: "已核实后台" } : { kind: "tool_calls", calls: [{ id: "status-restricted", name: "process_status", arguments: { process_id: processId } }] };
    }
    const stages = [
      { id: "stop", name: "process_stop", arguments: { process_id: processId } },
      { id: "status", name: "process_status", arguments: { process_id: processId } },
      { id: "write", name: "write", arguments: { path: "after.txt", content: "重新取得目录" } },
    ];
    if (step === 1 && t.runtime.listBackgroundProcesses(session.id).processes[0].state !== "stopped") return { kind: "tool_calls", calls: [{ id: `status-${Date.now()}`, name: "process_status", arguments: { process_id: processId } }] };
    if (step < stages.length) return { kind: "tool_calls", calls: [stages[step++]] };
    return { kind: "text", text: "后台已停止并完成写入" };
  }, { workDirs: 1, config: { ...realTools(), product: product.runtime } });
  const session = await t.runtime.createSession({ projectName: "background", cwd: t.work[0], mode: "full_access" });
  const ready = path.join(t.work[0], "url");
  const script = `const fs=require('node:fs'),http=require('node:http');const server=http.createServer((req,res)=>res.end('BACKGROUND_OK'));server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;fs.writeFileSync(${JSON.stringify(ready)},url);process.stdout.write(url+'\\n');});`;
  command = `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
  try {
    const first = await t.runtime.submit({ sessionId: session.id, requestId: "start", input: "启动HTTP后台", modelSelection: t.runtime.defaultSelection });
    await waitFor("启动轮结束", () => ["completed", "failed", "interrupted"].includes(t.runtime.store.getTask(first.id)!.status), 30_000);
    const record = t.runtime.listBackgroundProcesses(session.id).processes[0];
    assert.ok(record, JSON.stringify(t.runtime.store.listToolOpsByTask(first.id)));
    assert.equal(record.state, "running", JSON.stringify(record));
    assert.deepEqual(backgroundProcessForModel(record).source, { kind: "coding-owner", accessMode: "full_access" });
    assert.equal("taskId" in backgroundProcessForModel(record), false);
    processId = record.id;
    assert.equal(t.runtime.store.getTask(first.id)!.status, "completed", t.runtime.store.getTask(first.id)!.errorMessage ?? "");
    assert.equal(listAgentWaits(t.runtime.store, { sessionId: session.id }).length, 0);
    assert.equal(fs.existsSync(path.join(t.work[0], "forbidden.txt")), false);
    assert.ok(!toolNamesOf(t.server.calls[1]).includes("write"));
    assert.ok(toolNamesOf(t.server.calls[1]).includes("browser"));
    assert.equal(t.runtime.store.getOccupancyByDir(session.cwdReal)?.processId, processId);
    await waitFor("HTTP服务准备完成", () => fs.existsSync(ready));
    const url = fs.readFileSync(ready, "utf8");
    assert.equal(await (await fetch(url)).text(), "BACKGROUND_OK");
    await waitFor("后台日志已捕获", () => getBackgroundProcess(t.runtime.store, processId)!.stdoutBytes > 0);
    const output = t.runtime.backgroundProcessOutput({ sessionId: session.id, processId, stream: "stdout" });
    assert.equal(Buffer.from(output.base64, "base64").toString("utf8"), output.text);
    assert.ok(output.text.includes(url));
    const other = await t.runtime.createSession({ projectName: "other", cwd: t.work[0] });
    const blocked = await t.runtime.submit({ sessionId: other.id, requestId: "blocked", input: "同目录写入", accessMode: "full_access", modelSelection: t.runtime.defaultSelection });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.runtime.store.getTask(blocked.id)!.status, "queued");
    assert.ok(!toolNamesOf(t.server.calls[1]).includes("subagent_delegate"));
    assert.ok(!toolNamesOf(t.server.calls[1]).includes("agent_wait"));
    await t.runtime.cancelTask(blocked.id);
    assert.throws(() => t.runtime.backgroundProcessOutput({ sessionId: other.id, processId, stream: "stdout" }), { code: "background_not_found" });
    await assert.rejects(t.runtime.stopBackgroundProcess({ sessionId: other.id, processId }), { code: "background_not_found" });
    phase = "restricted";
    const version = t.runtime.getSession(session.id)!.defaultAccessModeVersion;
    await t.runtime.setSessionDefaultMode({ sessionId: session.id, mode: "plan", expectedVersion: version });
    const second = await t.runtime.submit({ sessionId: session.id, requestId: "restricted", input: "查询后台", modelSelection: t.runtime.defaultSelection });
    await waitFor("无agent_wait历史的新会话跨轮查状态", () => t.runtime.store.getTask(second.id)!.status === "completed", 30_000);
    assert.equal(t.runtime.listBackgroundProcesses(session.id).processes[0].state, "running");
    phase = "stop";
    const third = await t.runtime.submit({ sessionId: session.id, requestId: "stop", input: "停止并写入", accessMode: "full_access", modelSelection: t.runtime.defaultSelection });
    await waitFor("停止后同轮完成写入", () => ["completed", "failed", "interrupted"].includes(t.runtime.store.getTask(third.id)!.status), 30_000);
    assert.equal(t.runtime.store.getTask(third.id)!.status, "completed", JSON.stringify(t.runtime.store.listToolOpsByTask(third.id)));
    assert.equal(fs.readFileSync(path.join(t.work[0], "after.txt"), "utf8"), "重新取得目录");
    assert.equal(listActiveBackgroundProcesses(t.runtime.store).length, 0);
    assert.equal(t.runtime.store.listAllOccupancy().length, 0);
    await assert.rejects(fetch(url));
    const entries = parseSessionFile(t.runtime.store.getSession(session.id)!.sessionFile!);
    assert.ok(JSON.stringify(entries).includes("process_start"));
    assert.ok(t.runtime.store.listSelectionRecordsByTask(first.id).length >= 2);
  } finally { await t.shutdown(); }
});
