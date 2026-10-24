import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";
import { inputText, lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

for (const product of [codeProduct]) test(`${product.runtime.type} 的实际模型目录、角色正文、消息及冷恢复可重建`, async () => {
  const calls: { system: string | null; input: string; signature?: string | null }[] = [];
  let active: Runtime | null = null;
  const kit = await startTestRuntime("role-driver", req => {
    const driver = active && [...active["drivers"].values()].find(driver => driver["sdk"]?.systemPrompt.includes("ROLE_"));
    calls.push({ system: req.system, input: inputText(req), signature: driver?.["toolSignature"] });
    return { kind: "text", text: lastUserText(req).includes("[SubAgent") ? "子任务完成" : "父任务完成" };
  }, { config: { product: product.runtime } });
  let recovered: Runtime | null = null;
  try {
    const rt = kit.runtime;
    active = rt;
    const root = path.join(kit.dirs.agentDir, "agents");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "scout.md"), "---\ndescription: 阅读资料确认事实\n---\nROLE_PINNED_BODY");
    const session = await rt.createSession({ projectName: "role-driver", cwd: kit.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "目录选择", modelSelection: rt.defaultSelection });
    await waitFor("父模型接收目录", () => rt.store.getTask(parent.id)?.status === "completed");
    assert.ok(calls.some(call => call.input.includes("[子代理角色目录]") && call.input.includes("scout：阅读资料确认事实")));
    const parentFile = rt.store.getSession(session.id)!.sessionFile!;
    assert.ok(parseSessionFile(parentFile).some(entry => entry.type === "custom" && entry.customType === "ruukoto_subagent_roles" && JSON.stringify(entry.data).includes("ROLE_PINNED_BODY")));
    const query = await kit.client.request("list_subagent_roles", {});
    assert.ok((query as { roles: { name: string }[] }).roles.some(role => role.name === "scout"));
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, request: "检查指定资料", key: "first", role: "scout", readPaths: ["."], paramsDigest: "first" });
    await waitFor("角色任务结束", () => rt.store.getTask(first.task.id)?.status === "completed");
    assert.ok(calls.some(call => call.system?.includes("ROLE_PINNED_BODY")));
    const record = rt.store.listSelectionRecordsByTask(first.task.id).at(-1)!;
    assert.ok(record.promptArtifactId);
    const bytes = rt.queryArtifact({ taskId: first.task.id, artifactId: record.promptArtifactId!, offset: 0, length: 256 * 1024 });
    assert.match(Buffer.from(bytes!.data, "base64").toString(), /ROLE_PINNED_BODY/);
    const firstSignature = calls.at(-1)!.signature;
    fs.writeFileSync(path.join(root, "scout.md"), "---\ndescription: 阅读资料确认事实\n---\nROLE_NEW_BODY");
    const second = await delegateFromActiveTask(rt, { parentTaskId: parent.id, request: "新建角色", key: "second", role: "scout", readPaths: ["."], paramsDigest: "second" });
    await waitFor("新角色任务结束", () => rt.store.getTask(second.task.id)?.status === "completed");
    assert.ok(calls.some(call => call.system?.includes("ROLE_NEW_BODY")));
    const secondSignature = calls.at(-1)!.signature;
    assert.notEqual(first.agent.definition!.digest, second.agent.definition!.digest);
    assert.ok(firstSignature?.includes(first.agent.definition!.digest));
    assert.ok(secondSignature?.includes(second.agent.definition!.digest));
    assert.notEqual(firstSignature, secondSignature);
    const continuation = await delegateFromActiveTask(rt, { parentTaskId: parent.id, workId: first.work.id, request: "继续原任务", key: "continue", paramsDigest: "continue" });
    await waitFor("继续结束", () => rt.store.getTask(continuation.task.id)?.status === "completed");
    assert.match(calls.at(-1)!.system!, /ROLE_PINNED_BODY/);
    const message = await messageFromActiveTask(rt, { senderTaskId: parent.id, workId: first.work.id, toSubAgentId: first.agent.id, key: "message", text: "补充核对", paramsDigest: "message" });
    await waitFor("消息结束", () => rt.store.getTask(message.message.deliveredTaskId!)?.status === "completed");
    assert.match(calls.at(-1)!.system!, /ROLE_PINNED_BODY/);
    fs.unlinkSync(path.join(root, "scout.md"));
    kit.client.close();
    await rt.stop("test_restart");
    recovered = await Runtime.start({ ...rt.config, socketPath: path.join(kit.dirs.root, "recovered.sock") });
    active = recovered;
    const resumed = await delegateFromActiveTask(recovered, { parentTaskId: parent.id, workId: first.work.id, request: "冷恢复继续", key: "cold", paramsDigest: "cold" });
    await waitFor("冷恢复结束", () => recovered!.store.getTask(resumed.task.id)?.status === "completed");
    assert.match(calls.at(-1)!.system!, /ROLE_PINNED_BODY/);
    recovered.store.db.prepare("UPDATE sub_agents SET definition = ? WHERE id = ?").run("{}", first.agent.id);
    const before = calls.length;
    await assert.rejects(delegateFromActiveTask(recovered, { parentTaskId: parent.id, workId: first.work.id, request: "拒绝损坏", key: "bad", paramsDigest: "bad" }), { code: "definition_corrupt" });
    assert.equal(calls.length, before);
    assert.equal(recovered.snapshot().subAgents.find(agent => agent.id === first.agent.id)!.definitionError, "definition_corrupt");
  } finally { await recovered?.stop("test_end"); await kit.shutdown(); }
});

test("首次响应后定义损坏阻止后续发送与工具执行，父会话仍能查询诊断", async () => {
  let runtime: Runtime | null = null, childCalls = 0;
  const kit = await startTestRuntime("role-corrupt", req => {
    if (req.system?.includes("ROLE_CORRUPTION_TEST")) {
      childCalls++;
      const agent = runtime!.store.listSubAgents()[0];
      runtime!.store.db.prepare("UPDATE sub_agents SET definition = ? WHERE id = ?").run("{}", agent.id);
      return { kind: "tool_calls", calls: [{ id: "blocked-read", name: "read", arguments: { path: "." } }] };
    }
    return { kind: "text", text: "父会话可用" };
  });
  try {
    runtime = kit.runtime;
    const root = path.join(kit.dirs.agentDir, "agents");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "scout.md"), "---\ndescription: 核实记录\n---\nROLE_CORRUPTION_TEST");
    const session = await runtime.createSession({ projectName: "corrupt", cwd: kit.work[0] });
    const parent = await runtime.submit({ sessionId: session.id, requestId: "parent", input: "创建子任务", modelSelection: runtime.defaultSelection });
    await waitFor("父完成", () => runtime!.store.getTask(parent.id)?.status === "completed");
    const child = await delegateFromActiveTask(runtime, { parentTaskId: parent.id, request: "核实资料", key: "child", role: "scout", readPaths: ["."], paramsDigest: "child" });
    await waitFor("坏记录任务拒绝", () => runtime!.store.getTask(child.task.id)?.status === "failed");
    assert.equal(childCalls, 1);
    assert.equal(runtime.store.listToolOpsByTask(child.task.id).length, 0);
    assert.equal(runtime.snapshot().subAgents[0].definitionError, "definition_corrupt");
    const next = await runtime.submit({ sessionId: session.id, requestId: "next", input: "解释加载错误", modelSelection: runtime.defaultSelection });
    await waitFor("父仍可运行", () => runtime!.store.getTask(next.id)?.status === "completed");
  } finally { await kit.shutdown(); }
});
