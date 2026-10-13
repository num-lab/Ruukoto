import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { getWorkflowStep, listWorkflowExecutions, listWorkflowSteps, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const SCRIPT = `
const changes = await Promise.all(input.map(id => agent("change_"+id, {request:"CHANGE_ITEM_"+id, mode:"modify", target:".", ...(id===6 ? {output:{format:"json",schema:{type:"number"}}} : {})})));
const validations = await Promise.all(input.map(id => agent("verify_"+id, {request:"VERIFY_ITEM_"+id, mode:"verify", verify:"change_"+id, dependsOn:["change_"+id]})));
const included = input.filter((id,i) => changes[i].status==="completed" && validations[i].status==="completed" && validations[i].value.passed);
const merge = await integrate("merge", {steps:included.map(id=>"verify_"+id), dependsOn:included.map(id=>"verify_"+id), check:"node check.mjs"});
return {coverage:input.map((id,i)=>({id,change:changes[i].status,validation:validations[i].status,included:included.includes(id)})),merge};
`;

test("编码六输入：共享三名额、失败依赖跳过、独立验证与实际五份冻结成果汇总，唯一部分失败回报", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  const t = await startTestRuntime("workflow-code-batch", async req => {
    const text = lastUserText(req);
    if (text.startsWith("[工作流最终回报]")) { assert.deepEqual(toolNamesOf(req), []); return { kind: "text", text: "五项已汇入，第六项失败" }; }
    const match = /(?:CHANGE|VERIFY)_ITEM_(\d)/.exec(text);
    assert.ok(match, text);
    const id = Number(match[1]), verify = text.includes("VERIFY_ITEM_");
    if (!afterTool(req) && !verify && ++held <= 3) await gate;
    if (id === 6) return { kind: "text", text: "故意失败" };
    if (afterTool(req)) return { kind: "text", text: verify ? '{"passed":true,"reason":"独立命令核实实际字节"}' : "修改完成" };
    return { kind: "tool_calls", calls: [{ id: `${verify ? "verify" : "write"}_${id}`, name: verify ? "bash" : "write", arguments: verify ?
      { command: `test "$(cat item-${id}.txt)" = changed-${id} && printf proof > verification-${id}.txt` } : { path: `item-${id}.txt`, content: `changed-${id}\n` } }] };
  }, { workDirs: 1, config: { ...realTools(), product: product.runtime } });
  try {
    for (let id = 1; id <= 6; id++) fs.writeFileSync(path.join(t.work[0], `item-${id}.txt`), `base-${id}\n`);
    fs.writeFileSync(path.join(t.work[0], "check.mjs"), 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; for(let i=1;i<=6;i++) assert.equal(readFileSync(`item-${i}.txt`,"utf8"),i===6?"base-6\\n":`changed-${i}\\n`);\n');
    initGitRepo(t.work[0]);
    const rt = t.runtime, session = await rt.createSession({ projectName: "acceptance", cwd: t.work[0] });
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "full_access" });
    await t.client.request("workflow_save", { name: "six", script: SCRIPT, expected_digest: null, request_id: "save" });
    const started = await t.client.request<OpResult<"workflow_start">>("workflow_start", { session_id: session.id, name: "six", request_id: "batch", input: [1, 2, 3, 4, 5, 6] });
    await waitFor("三个实际修改者并发且其余排队", () => held === 3 && listWorkflowExecutions(rt.store, started.run.id).filter(item => item.kind === "agent" && item.status === "running").length === 3, 60_000);
    assert.equal(listWorkflowSteps(rt.store, started.run.id).filter(step => step.status === "queued").length, 3);
    release();
    await waitFor("六输入整项回报", () => requireWorkflowRun(rt.store, started.run.id).delivery?.status === "reported", 90_000);
    const final = requireWorkflowRun(rt.store, started.run.id);
    assert.equal(final.status, "partial", final.reason ?? "");
    assert.equal(final.attempts, 11);
    assert.equal(final.scriptStopVerified, true);
    assert.equal(getWorkflowStep(rt.store, final.id, "change_6")!.status, "failed");
    assert.equal(getWorkflowStep(rt.store, final.id, "change_6")!.attempts, 1);
    assert.equal(getWorkflowStep(rt.store, final.id, "verify_6")!.status, "skipped");
    assert.equal(getWorkflowStep(rt.store, final.id, "verify_6")!.attempts, 0);
    assert.equal(getWorkflowStep(rt.store, final.id, "merge")!.status, "completed");
    for (let id = 1; id <= 5; id++) {
      const changed = getWorkflowStep(rt.store, final.id, `change_${id}`)!, verified = getWorkflowStep(rt.store, final.id, `verify_${id}`)!;
      assert.equal(verified.verification!.passed, true);
      assert.equal(verified.verification!.digest, changed.frozen!.digest);
      const modifyTask = rt.store.getTask(changed.frozen!.taskId)!, verifyTask = rt.store.getTask(verified.verification!.taskId)!;
      assert.notEqual(modifyTask.sessionId, verifyTask.sessionId);
      assert.notEqual(modifyTask.id, verifyTask.id);
      assert.equal(fs.readFileSync(path.join(t.work[0], `item-${id}.txt`), "utf8"), `changed-${id}\n`);
      const modifyPath = rt.store.getWorkDelegation(changed.frozen!.workId)!.writeTarget!.path;
      const verifyPath = rt.store.getWorkDelegation(verifyTask.workId!)!.writeTarget!.path;
      assert.notEqual(modifyPath, verifyPath);
      assert.equal(fs.existsSync(path.join(modifyPath, `verification-${id}.txt`)), false);
      assert.equal(fs.readFileSync(path.join(verifyPath, `verification-${id}.txt`), "utf8"), "proof");
      assert.equal(fs.existsSync(path.join(t.work[0], `verification-${id}.txt`)), false);
    }
    assert.equal(fs.readFileSync(path.join(t.work[0], "item-6.txt"), "utf8"), "base-6\n");
    assert.ok(listWorkflowExecutions(rt.store, final.id).every(item => item.stopVerified === true));
    assert.equal(rt.store.listAllOccupancy().length, 0);
    assert.match(final.delivery!.facts, /change_6.*failed/);
    assert.match(final.delivery!.facts, /verify_6.*skipped/);
    const result = final.result as { value: { coverage: Array<{ id: number; change: string; validation: string; included: boolean }> } };
    assert.deepEqual(result.value.coverage, [1, 2, 3, 4, 5, 6].map(id => ({ id, change: id === 6 ? "failed" : "completed", validation: id === 6 ? "skipped" : "completed", included: id !== 6 })));
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => task.requestId.startsWith("workflow-final:")).length, 1);
    assert.equal(rt.store.listTasksBySession(session.id).some(task => task.requestId.startsWith("wake:")), false);
  } finally { release(); await t.shutdown(); }
});
