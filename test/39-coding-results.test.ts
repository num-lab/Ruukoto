import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, lastUserText, makeTestDirs, startTestRuntime, waitFor, writeModelsJson } from "./helpers/testkit.ts";

test("恢复：重试创建被拒仍记录首次失败并继续启动，已有重试不重复，后续只补唤醒一次", async () => {
  const { dirs } = await makeTestDirs("coding-retry-rejected", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "已汇报" }));
  await writeModelsJson(dirs, await server.start());
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: createMockTools,
    qqDisabled: true, telegramDisabled: true,
  };
  let rt = await Runtime.start(config);
  try {
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "parent", input: "分析代码", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.getTaskDetail(parent.id)!.task.status === "completed");

    // 沿用恢复测试的持久崩溃状态：任务失败已落库，结果处理尚未执行。
    rt.store.setSessionQueueState(coding.sessionId, "paused", "test_fixture");
    const children = [];
    const endedAt = new Date().toISOString();
    for (const key of ["rejected", "existing"]) {
      const child = await rt.submit({
        sessionId: coding.sessionId, requestId: `deleg:${parent.id}:${key}`,
        input: `[委派 coding · analyze]\n${key}`, modelSelection: rt.defaultSelection,
        accessMode: "confirm", agentId: "coding", parentTaskId: parent.id,
      });
      rt.store.transitionTask(child.id, ["queued"], "failed", { endedAt, errorMessage: `首次分析失败：${key}` });
      children.push(child);
    }
    const [rejected, existing] = children;
    // 第二个任务的重试已经持久化，但首次结果尚未记录。
    const retry = await rt.submit({
      sessionId: coding.sessionId, requestId: `${existing.requestId}:retry`, input: existing.input,
      modelSelection: rt.defaultSelection, accessMode: "confirm", agentId: "coding", parentTaskId: parent.id,
      deadline: new Date(Date.parse(endedAt) + 3_600_000).toISOString(),
    });
    rt.store.transitionTask(retry.id, ["queued"], "failed", { endedAt, errorMessage: "重试分析失败" });

    await rt.stop("test_restart");
    // systemd 仅支持 full_access；confirm 重试和唤醒提交被拒不能阻止后台恢复。
    rt = await Runtime.start({ ...config, execution: { backend: "systemd" } });
    const failed = rt.getTaskDetail(rejected.id)!.task;
    const result = JSON.parse(failed.resultRef!);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failure, "首次分析失败：rejected");
    assert.match(failed.resultSummary!, /首次分析失败：rejected/);
    assert.equal(result.needsOwner, true);
    assert.match(result.needsOwnerReason, /自动重试创建失败/);
    assert.match(result.needsOwnerReason, /systemd/);
    assert.equal(result.retriedBy, undefined);
    assert.equal(JSON.parse(rt.getTaskDetail(existing.id)!.task.resultRef!).retriedBy, retry.id);
    assert.equal(JSON.parse(rt.getTaskDetail(retry.id)!.task.resultRef!).failure, "重试分析失败", "继续处理后续待恢复结果");

    // 后端恢复后补发原失败和既有重试的唤醒，再重启也不重试、不重复唤醒。
    for (let restart = 0; restart < 2; restart++) {
      await rt.stop("test_restart");
      rt = await Runtime.start(config);
      await waitFor("两次最终结果唤醒完成", () => {
        const wakes = rt.listTasks({ sessionId: main.sessionId }).tasks.filter((task) => task.requestId.startsWith("wake:"));
        return wakes.length === 2 && wakes.every((task) => task.status === "completed");
      });
      const wakes = rt.listTasks({ sessionId: main.sessionId }).tasks.filter((task) => task.requestId.startsWith("wake:"));
      assert.deepEqual(wakes.map((task) => task.requestId).sort(), [`wake:${rejected.id}`, `wake:${retry.id}`].sort());
      assert.match(wakes.find((task) => task.requestId === `wake:${rejected.id}`)!.input, /需要拥有者：是.*自动重试创建失败/);
      assert.equal(rt.listTasks({ sessionId: coding.sessionId }).tasks.length, 3);
    }
  } finally {
    await rt.stop("test_end");
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("结果自报：跨页长原因完整识别后限长，最后的测试和 owner 字段覆盖前文", async () => {
  const longReport = "格式示例：\n测试：通过\n需要拥有者：否\n" +
    "分析过程。\n".repeat(1500) +
    `测试：失败\n需要拥有者：是（需要补充权限：${"界".repeat(24_000)}）`;
  const t = await startTestRuntime("coding-report-pages", async (req) => {
    const input = lastUserText(req);
    if (input.startsWith("[委派 coding")) {
      return { kind: "text", text: longReport + (input.endsWith("last") ? "\n测试：未运行\n需要拥有者：否" : "") };
    }
    if (input.startsWith("[编排器]")) return { kind: "text", text: "已汇报" };
    if (req.messages.at(-1)?.role === "tool") return { kind: "text", text: "已委派" };
    return { kind: "tool_calls", calls: [{ id: "delegate", name: "coding_delegate", arguments: { request: input, mode: "draft", key: "report" } }] };
  });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    for (const key of ["long", "last"]) {
      const parent = await rt.submit({ sessionId: main.sessionId, requestId: key, input: key, modelSelection: rt.defaultSelection });
      await waitFor("父任务完成委派", () => rt.getTaskDetail(parent.id)!.task.status === "completed");
      const child = rt.listTasks({ sessionId: coding.sessionId }).tasks.find((task) => task.parentTaskId === parent.id)!;
      await waitFor("结果唤醒完成", () => rt.listTasks({ sessionId: main.sessionId }).tasks.some((task) => task.requestId === `wake:${child.id}` && task.status === "completed"));
      const result = JSON.parse(rt.getTaskDetail(child.id)!.task.resultRef!);
      assert.equal(result.tests, key === "long" ? "failed" : "not_run");
      assert.equal(result.needsOwner, key === "long");
      if (key === "long") {
        assert.match(result.needsOwnerReason, /coding 自报：需要补充权限/);
        assert.ok(result.needsOwnerReason.length < 1200, "识别完整原因后限长保存");
      } else {
        assert.equal(result.needsOwnerReason, null);
      }
      const wake = rt.listTasks({ sessionId: main.sessionId }).tasks.find((task) => task.requestId === `wake:${child.id}`)!;
      assert.ok(wake.input.length < 4096, "长原因不扩大 main 唤醒输入");
      const delivered = t.server.calls.find((call) => lastUserText(call) === wake.input);
      assert.ok(delivered, "结果确实传给 main 的模型");
      assert.match(lastUserText(delivered), key === "long" ? /测试：失败（coding 自报） · 需要拥有者：是/ : /测试：未运行（coding 自报） · 需要拥有者：否/);
    }
  } finally {
    await t.shutdown();
  }
});
