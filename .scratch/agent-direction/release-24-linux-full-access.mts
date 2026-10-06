/** 模型模拟；Linux 专用执行账户、sudoers 固定入口、systemd、文件和拒读真实。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestRuntime, createProjectSession, taskStatus, waitFor, realTools } from "../../test/helpers/testkit.ts";
import type { Responder } from "../../test/helpers/mock-provider.ts";
let tokenPath = "", dbPath = "";
const responder: Responder = req => {
  const done = req.messages.filter(m => m.role === "tool").length;
  const calls = [
    { id: "read", name: "read", arguments: { path: "sum.mjs" } },
    { id: "before", name: "bash", arguments: { command: "node check.mjs" } },
    { id: "edit", name: "edit", arguments: { path: "sum.mjs", edits: [{ oldText: "let total = 1;", newText: "let total = 0;" }] } },
    { id: "after", name: "bash", arguments: { command: `node check.mjs && id -u > uid.txt && id -g > gid.txt && (cat '${tokenPath}' >/dev/null 2>&1; echo $? > token-exit.txt) && (cat '${dbPath}' >/dev/null 2>&1; echo $? > db-exit.txt)` } },
  ];
  return done < calls.length ? { kind: "tool_calls", calls: [calls[done]!] } : { kind: "text", text: "完全访问修改与测试完成" };
};
const t = await startTestRuntime("release24-full", responder, { workDirs: 1, config: { productType: "ruukoto-dev", ...realTools(), execution: { backend: "container", container: { uid: 986, gid: 986 } } } });
try {
  const workspace = t.work[0]!;
  fs.chmodSync(t.dirs.root, 0o755); fs.chmodSync(workspace, 0o777);
  // 按真实部署目录权限保护后台材料；testkit 默认 mkdir 不承担部署职责。
  fs.chmodSync(t.dirs.dataDir, 0o700); fs.chmodSync(t.dirs.agentDir, 0o700);
  fs.writeFileSync(path.join(workspace, "sum.mjs"), "export function sum(xs) { let total = 1; for (const x of xs) total += x; return total; }\n");
  fs.writeFileSync(path.join(workspace, "check.mjs"), "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum([1,2,3]),6); console.log('PASS');\n");
  fs.chmodSync(path.join(workspace, "sum.mjs"), 0o666);
  tokenPath = path.join(t.runtime.controlDir(), "owner.token"); dbPath = path.join(t.dirs.dataDir, "ruukoto.db");
  const {sessionId} = await createProjectSession(t.client, workspace);
  const task = await t.client.request<any>("submit", { session_id: sessionId, request_id: "full-access-code", input: "修复 sum 并测试", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
  await waitFor("完全访问终态", async () => ["completed","failed"].includes((await taskStatus(t.client,task.id)).task.status), 120_000);
  const detail = await taskStatus(t.client, task.id);
  console.log(JSON.stringify(detail.toolOps.map((op:any)=>({call:op.sdkCallId,error:op.isError,result:op.resultSummary})),null,2));
  assert.equal(detail.task.status, "completed", JSON.stringify(detail));
  assert.equal(detail.task.accessMode, "full_access");
  assert.equal(detail.toolOps.find((o:any)=>o.sdkCallId==="before").isError,true);
  assert.equal(detail.toolOps.find((o:any)=>o.sdkCallId==="after").isError,false);
  assert.match(fs.readFileSync(path.join(workspace,"sum.mjs"),"utf8"), /let total = 0;/);
  assert.equal(fs.readFileSync(path.join(workspace,"uid.txt"),"utf8").trim(),"986");
  assert.equal(fs.readFileSync(path.join(workspace,"gid.txt"),"utf8").trim(),"986");
  assert.notEqual(fs.readFileSync(path.join(workspace,"token-exit.txt"),"utf8").trim(),"0");
  assert.notEqual(fs.readFileSync(path.join(workspace,"db-exit.txt"),"utf8").trim(),"0");
  console.log(`PASS 完全访问专用 uid:gid=986:986 修改代码/修前失败/修后通过；owner.token 与核心库读取拒绝；task=${task.id}; operations=${detail.toolOps.length}; mode=${detail.task.accessMode}`);
} finally { await t.shutdown(); }
