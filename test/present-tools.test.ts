import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import { createLocalLauncher, ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import { createManagedProcessRegistry } from "@ruukoto/agent/managed-processes.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { ToolRouter } from "@ruukoto/agent/tool-router.ts";
import { sourceAllows, subAgentAllows, taskToolSet, workflowAllows, type WorkflowExecutionProfile } from "@ruukoto/agent/tool-availability.ts";
import { cleanupDirs, createProjectSession, lastToolText, makeTestDirs, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

test("present 只装配拥有者会话，子代理和工作流显式清单也不扩大资格", () => {
  const profile: WorkflowExecutionProfile = { toolClass: "dev", sourceProjectId: "project", categories: ["coding"], tools: ["present"], verifyTarget: true };
  assert.equal(sourceAllows(profile, "present"), false); assert.equal(workflowAllows(profile, "present"), false);
  for (const write of [true, false]) for (const review of [true, false]) assert.equal(subAgentAllows({ write, review }, "present"), false);
  for (const plan of [true, false]) assert.equal(taskToolSet({ registered: ["present"], plan, webSearchEnabled: true, mcpEffect: () => undefined }).allowed.has("present"), true);
});

test("present 文件沿 worker 钉定读取范围，域外文件不会成为预览产物", async () => {
  const { dirs, work } = await makeTestDirs("present-scope", 1), db = new Db(dirs.dataDir), store = new Store(db);
  const project = store.createProject("present"), workspace = fs.realpathSync(work[0]), stat = fs.statSync(workspace);
  const session = store.createSession({ projectId: project.id, cwd: workspace, cwdReal: workspace, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "present", confirmTools: [] });
  const { task } = store.insertQueuedTask({ sessionId: session.id, requestId: "present", input: "预览", submissionDigest: "present", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, readScope: { paths: [], sourceRefs: [] } });
  const unused = () => { throw new ExecutionError("approval_unused", "范围读取不请求审批"); };
  const router = new ToolRouter({ store, ledger: new ToolOpLedger(store), artifacts: new ArtifactStore(dirs.dataDir, store), credentials: new CredentialStore(dirs.agentDir), registry: createManagedProcessRegistry(), launcherFor: () => createLocalLauncher(), protectedRoots: [dirs.dataDir], approvals: { request: unused, defer: unused, consumeDeferred: unused, supersedeAll() {} } });
  try {
    const outside = path.join(dirs.dataDir, "private.txt"); fs.writeFileSync(outside, "不可捕获的正文");
    fs.writeFileSync(path.join(workspace, "allowed.txt"), "允许内容");
    const allowed = await router.executeTool({ task, hostOpId: "allowed", sdkCallId: "allowed", name: "present", params: { path: "allowed.txt" } });
    assert.equal(allowed.isError, false); assert.equal(router.artifactIdsFor("allowed").length, 1);
    const denied = await router.executeTool({ task, hostOpId: "denied", sdkCallId: "denied", name: "present", params: { path: outside } });
    assert.equal(denied.isError, true); assert.deepEqual(router.artifactIdsFor("denied"), []);
    assert.match(JSON.stringify(denied), /超出宿主钉定的只读范围/); assert.doesNotMatch(JSON.stringify(denied), /不可捕获的正文/);
  } finally { await router.stopWorker(); db.close(); await cleanupDirs(dirs); }
});

test("present 沿真实读取捕获当时文件和空文件，失败无预览结果，URL 限完全访问", async () => {
  let params: Record<string, unknown> = {}, output = "";
  const h = await startTestRuntime("present", request => {
    if (request.messages.at(-1)?.role === "tool") { output = lastToolText(request); return { kind: "text", text: "已处理" }; }
    return { kind: "tool_calls", calls: [{ id: "present-call", name: "present", arguments: params }] };
  }, { workDirs: 1, config: { ...realTools(), product: product.runtime } });
  try {
    fs.writeFileSync(path.join(h.work[0], "file.md"), "# 当时版本\n");
    fs.writeFileSync(path.join(h.work[0], "empty.txt"), "");
    let count = 0;
    const run = async (input: Record<string, unknown>, accessMode: "confirm" | "full_access" = "full_access") => {
      params = input; output = "";
      const { sessionId } = await createProjectSession(h.client, h.work[0], { projectName: `present-${++count}` });
      const task = await h.runtime.submit({ sessionId, requestId: "present", input: "打开预览", accessMode, modelSelection: h.runtime.defaultSelection });
      await waitFor("present 结束", () => h.runtime.store.getTask(task.id)?.status === "completed", 30_000);
      const operation = h.runtime.store.listToolOpsByTask(task.id)[0];
      return { task, operation, error: operation?.isError ?? h.runtime.readHistory({ sessionId }).entries.find(entry => entry.toolName === "present")?.isError,
        artifacts: h.runtime.store.listArtifactsByTask(task.id).filter(artifact => artifact.name === "present 文件正文") };
    };
    const file = await run({ path: "file.md" });
    assert.equal(file.operation.isError, false); assert.equal(file.artifacts.length, 1);
    fs.writeFileSync(path.join(h.work[0], "file.md"), "之后版本");
    const captured = await h.client.request<{ data: string }>("read_artifact", { task_id: file.task.id, artifact_id: file.artifacts[0].id });
    assert.equal(Buffer.from(captured.data, "base64").toString(), "# 当时版本\n");
    assert.match(output, /请求已记录/); assert.doesNotMatch(output, /# 当时版本/);
    const empty = await run({ path: "empty.txt" });
    assert.equal(empty.operation.isError, false); assert.equal(empty.artifacts.length, 1);
    const emptyBytes = await h.client.request<{ data: string }>("read_artifact", { task_id: empty.task.id, artifact_id: empty.artifacts[0].id });
    assert.equal(emptyBytes.data, "");
    const missing = await run({ path: "missing.txt" });
    assert.equal(missing.operation.isError, true); assert.equal(missing.artifacts.length, 0);
    for (const input of [{ url: "javascript:alert(1)" }, { url: "https://user:secret@example.com" }, { url: "file:///tmp/file.md" }, { path: "file.md", url: "https://example.com" }, {}]) {
      assert.equal((await run(input)).error, true, JSON.stringify(input));
    }
    assert.equal((await run({ url: "https://example.com/page" }, "confirm")).operation.isError, true);
    assert.equal((await run({ url: "https://example.com/page" })).operation.isError, false);
    assert.match(output, /不代表页面已加载/);
    assert.ok(h.server.calls.some(request => request.tools?.some(tool => (tool.function as { name?: string } | undefined)?.name === "present")));
  } finally { await h.shutdown(); }
});
