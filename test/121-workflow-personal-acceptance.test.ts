import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getWorkflowQuestion, getWorkflowStep, listWorkflowExecutions, listWorkflowRuns, listWorkflowSteps, requireWorkflowRun, WORKFLOW_LIMITS } from "@ruukoto/core/workflow.ts";
import { AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { afterTool, inputText, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const INPUTS = ["one", "two", "three", "four", "five", "six"];
const RECORD_SCHEMA = { type: "object", properties: { id: { type: "string" }, evidence: { type: "string" } }, required: ["id", "evidence"], additionalProperties: false };
const SCRIPT = `
const researched = await Promise.all(input.map(id => agent("read_"+id,{request:"RESEARCH:"+id,tools:["web_search","app_data_query"],output:{format:"json",schema:${JSON.stringify(RECORD_SCHEMA)}}})));
const checked = await Promise.all(input.map(id => agent("check_"+id,{request:"VERIFY:"+id,dependsOn:["read_"+id],tools:["web_search"],output:{format:"json",schema:{type:"object",properties:{passed:{type:"boolean"}},required:["passed"],additionalProperties:false}}})));
const coverage = input.map((id,i)=>({id,research:researched[i].status,validation:checked[i].status,included:researched[i].status==="completed" && checked[i].status==="completed" && checked[i].value.passed===true}));
await progress("coverage",{coverage});
const answer = await ask("confirm",{prompt:JSON.stringify(coverage),options:["record","cancel"]});
if(answer.status==="completed" && answer.value==="record") {
  const records=coverage.filter(x=>x.included).map(x=>researched[input.indexOf(x.id)].value);
  await agent("record",{request:"RECORD:"+JSON.stringify(records),tools:["app_data_define_table","app_data_insert"],dependsOn:coverage.filter(x=>x.included).map(x=>"check_"+x.id)});
}
return {coverage,answer:answer.value};
`;

test("个人六输入命名工作流：实际搜索工具与应用数据、独立检查、单项 JSON 失败、等待聊天及唯一 IM 替身回报", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queries: string[] = [];
  const search = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as { query: string };
      queries.push(body.query);
      void gate.then(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ results: [{ title: body.query, url: `https://example.com/${body.query}`, content: "Evidence-" + body.query }] }));
      });
    });
  });
  await new Promise<void>(resolve => search.listen(0, "127.0.0.1", resolve));
  const address = search.address(); assert.ok(address && typeof address !== "string");
  const searchUrl = `http://127.0.0.1:${address.port}`;
  const api = new FakeBotApi({ token: "123:personal-acceptance", ownerId: 42 }), apiBase = await api.start();
  const checkedInputs = new Map<string, unknown>();
  const t = await startTestRuntime("workflow-personal-six", req => {
    const text = lastUserText(req);
    if (text.startsWith("[工作流最终回报]")) {
      assert.deepEqual(toolNamesOf(req), []);
      assert.match(text, /read_six.*failed/);
      assert.match(text, /check_six.*skipped/);
      return { kind: "text", text: "PERSONAL-FINAL：五项已核实并记录，第六项格式失败，其检查已跳过。" };
    }
    if (text.includes("日常聊天")) return { kind: "text", text: "CHAT-OK" };
    const input = JSON.parse(text) as { params: { request: string }; dependsOn: unknown[] };
    const [phase, id] = input.params.request.split(":");
    if (phase === "RESEARCH" || phase === "VERIFY") {
      assert.ok(INPUTS.includes(id));
      assert.deepEqual(toolNamesOf(req).sort(), phase === "RESEARCH" ? ["app_data_query", "web_search"] : ["web_search"]);
      if (!afterTool(req)) {
        if (phase === "VERIFY") {
          assert.deepEqual(input.dependsOn, [{ status: "completed", value: { id, evidence: "Evidence-" + id } }]);
          checkedInputs.set(id, input.dependsOn);
        }
        return { kind: "tool_calls", calls: [
          { id: "search", name: "web_search", arguments: { query: id } },
          ...(phase === "RESEARCH" ? [{ id: "schema", name: "app_data_query", arguments: { mode: "schema" } }] : []),
        ] };
      }
      assert.match(inputText(req), new RegExp("Evidence-" + id));
      return { kind: "text", text: phase === "VERIFY" ? '{"passed":true}' : id === "six" ? "{bad-json" : JSON.stringify({ id, evidence: "Evidence-" + id }) };
    }
    assert.equal(phase, "RECORD");
    const records = JSON.parse(input.params.request.slice("RECORD:".length)) as Array<{ id: string; evidence: string }>;
    assert.deepEqual(records, INPUTS.slice(0, 5).map(id => ({ id, evidence: "Evidence-" + id })));
    const done = req.messages.filter(message => message.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "define", name: "app_data_define_table", arguments: {
      table: "researched", fields: [{ name: "id", type: "text" }, { name: "evidence", type: "text" }], expected_schema_version: 0, reason: "记录五项独立检查通过的资料",
    } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "insert", name: "app_data_insert", arguments: { table: "researched", records, reason: "拥有者已回答 record" } }] };
    return { kind: "text", text: "五项资料已记录" };
  }, { config: { ...realTools(), webSearch: { baseUrl: searchUrl }, scheduler: { tickMs: 20 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } } });
  const rt = t.runtime;
  try {
    await rt.addCredentialBinding({ name: "search", host: new URL(searchUrl).host, header: "authorization", purpose: "tavily_search", secret: "virtual-search" });
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: "123:personal-acceptance" });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await waitFor("个人 IM 替身在线", () => rt.telegramStatus().online === true);
    await rt.saveWorkflowDefinition({ name: "personal-six", script: SCRIPT, expectedDigest: null, requestKey: "six:save" });
    api.push({ text: "/workflow-run personal-six " + JSON.stringify(INPUTS) });
    await waitFor("两项真实搜索同时在途", () => queries.length >= 2 && listWorkflowRuns(rt.store).length === 1);
    const run = listWorkflowRuns(rt.store)[0];
    const active = listWorkflowSteps(rt.store, run.id).filter(step => step.status === "running").length;
    assert.ok(active >= 2 && active <= WORKFLOW_LIMITS.concurrency, "有界并发不能退化为串行");
    release();
    await waitFor("六项研究及独立检查结束，问题已沿原入口送达", () => requireWorkflowRun(rt.store, run.id).status === "waiting" &&
      rt.sched.listOps({ limit: 100 }).items.some(op => op.sourceKind === "workflow_question" && op.status === "sent"), 60_000);
    assert.equal(getWorkflowStep(rt.store, run.id, "read_six")!.status, "failed");
    assert.deepEqual(getWorkflowStep(rt.store, run.id, "read_six")!.result, { status: "failed", code: "output_invalid" });
    assert.equal(getWorkflowStep(rt.store, run.id, "read_six")!.rawOutput, "{bad-json");
    assert.equal(getWorkflowStep(rt.store, run.id, "read_six")!.attempts, 1);
    assert.equal(getWorkflowStep(rt.store, run.id, "check_six")!.status, "skipped");
    assert.equal(getWorkflowStep(rt.store, run.id, "check_six")!.attempts, 0);
    assert.deepEqual([...checkedInputs.keys()].sort(), INPUTS.slice(0, 5).sort());
    const executions = listWorkflowExecutions(rt.store, run.id);
    for (const id of INPUTS.slice(0, 5)) {
      const read = executions.find(item => item.stepKey === "read_" + id)!, check = executions.find(item => item.stepKey === "check_" + id)!;
      assert.notEqual(check.taskId, read.taskId);
      assert.notEqual(rt.store.getTask(check.taskId)!.sessionId, rt.store.getTask(read.taskId)!.sessionId);
    }
    assert.equal(queries.length, 11, "六次研究、五次独立重搜；格式失败不重试");
    const ops = executions.flatMap(item => rt.store.listToolOpsByTask(item.taskId));
    assert.equal(ops.filter(op => op.toolName === "app_data_query" && !op.isError).length, 6);
    api.push({ text: "日常聊天" });
    await waitFor("人工等待期间原入口仍可聊天", () => api.sends.some(send => String(send.text).includes("CHAT-OK")));
    const question = getWorkflowQuestion(rt.store, run.id, "confirm")!;
    assert.equal(question.status, "pending");
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "waiting");
    const answer = api.push({ text: `/workflow-answer ${run.id} confirm ${question.runVersion} ${question.version} "record"` });
    await waitFor("整项唯一最终回报已送达", () => rt.sched.listOps({ limit: 100 }).items.some(op => op.sourceKey.includes("#workflow-final:") && op.status === "sent"), 60_000);
    api.push({ message: answer });
    const lastUpdate = Number(api.updates.at(-1).update_id);
    await waitFor("重复回答入站偏移已推进", () => Number((rt.store.db.prepare("SELECT last_update_id FROM telegram_config WHERE id = 1").get() as { last_update_id: number }).last_update_id) >= lastUpdate);
    await rt.scheduler!.tick(); await rt.scheduler!.idle();
    const final = requireWorkflowRun(rt.store, run.id);
    assert.equal(final.status, "partial");
    assert.equal(final.attempts, 12);
    assert.deepEqual(final.result, {
      value: { coverage: INPUTS.map(id => ({ id, research: id === "six" ? "failed" : "completed", validation: id === "six" ? "skipped" : "completed", included: id !== "six" })), answer: "record" },
      steps: listWorkflowSteps(rt.store, run.id).map(step => ({ key: step.key, status: step.status, delivery: step.delivery })),
    });
    assert.equal(final.scriptStopVerified, true);
    assert.ok(listWorkflowExecutions(rt.store, run.id).every(execution => execution.stopVerified === true));
    assert.equal(rt.store.listAllOccupancy().length, 0);
    const data = new AppDataStore(path.join(t.dirs.dataDir, "agent-data", "main.db"), { readOnly: true });
    try {
      const table = data.listTables().find(item => item.name === "researched")!;
      assert.deepEqual([...data.scanRows(table, 0, 100)].map(row => ({ id: row.id, evidence: row.evidence })), INPUTS.slice(0, 5).map(id => ({ id, evidence: "Evidence-" + id })));
    } finally { data.close(); }
    const reports = rt.sched.listOps({ limit: 100 }).items.filter(op => op.sourceKey.includes("#workflow-final:"));
    assert.equal(reports.length, 1); assert.equal(reports[0].target.channel, "telegram");
    assert.match(reports[0].text, /终态 partial/); assert.match(reports[0].text, /read_six：failed/); assert.match(reports[0].text, /check_six：skipped/);
    assert.equal(api.sends.filter(send => String(send.text).includes("PERSONAL-FINAL")).length, 1);
    assert.equal(t.server.calls.filter(call => lastUserText(call).startsWith("[工作流最终回报]")).length, 1);
    const audit = new DatabaseSync(path.join(t.dirs.dataDir, "agent-data", "main.db"), { readOnly: true });
    try { assert.equal(audit.prepare("SELECT COUNT(*) AS count FROM app_audit WHERE tool_name = 'app_data_insert'").get()!.count, 1); }
    finally { audit.close(); }
  } finally {
    release();
    await t.shutdown(); await api.close();
    search.closeAllConnections(); await new Promise<void>(resolve => search.close(() => resolve()));
  }
});
