import { product as personalProduct } from "./helpers/legacy-product.ts";
/**
 * 集成：访问模式绑定任务与拥有者入口（issue 03 §2/§5/§6.3/§6.4）。
 *
 * 覆盖：
 * - 提交幂等比较包含模式与授权范围：同键同参返回原任务，改模式/改范围必须冲突；
 * - New Tasks use the current default mode or an explicit owner selection after pause;
 * - switch-mode 在无执行中工具的边界生效（权限版本递增并发出事件），
 *   任务结束后拒绝切换；
 * - 完全访问任务不逐次确认（本地开发后端）且不改动其他任务的模式；
 * - 受限原生入口不可用不妨碍完全访问使用启动账户；模式路由不扩大受限权限；
 * - 控制面拥有者认证：认证前不返回快照、不执行请求；
 * - 模型不能提升模式（不存在这种工具）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  startTestRuntime,
  routeResponder,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
  realTools,
} from "./helpers/testkit.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { readOwnerToken, TOKEN_FILE_NAME } from "@ruukoto/control/owner-token.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { createLauncherFor, ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import type { Responder } from "./helpers/mock-provider.ts";

function modeRoutes() {
  return routeResponder([
    {
      match: /SLOW/,
      respond: (req) => {
        const done = req.messages.filter((m) => m?.role === "tool").length;
        if (done === 0) {
          return { kind: "tool_calls", calls: [{ id: "m_slow", name: "mock_delay", arguments: { ms: 3000 } }] };
        }
        return { kind: "text", text: "slow-done" };
      },
    },
    { match: /QUICK/, respond: () => ({ kind: "text", text: "quick-done" }) },
  ]);
}

test("提交幂等比较包含访问模式与授权范围", async () => {
  const t = await startTestRuntime("mode-idem", modeRoutes(), { workDirs: 1 });
  try {
    const granted = path.join(t.dirs.root, "granted-dir");
    fs.mkdirSync(granted, { recursive: true });
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);

    const first = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "idem-1",
      input: "任务输入",
    });
    assert.equal(first.accessMode, "confirm", "默认请求确认");
    assert.equal(first.permissionVersion, 1);

    const retry = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "idem-1",
      input: "任务输入",
    });
    assert.equal(retry.id, first.id, "同键同参重试返回原任务");

    await assert.rejects(
      () =>
        t.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          session_id: sessionId,
          request_id: "idem-1",
          input: "任务输入",
          access_mode: "full_access",
        }),
      (err: any) => err.code === "request_conflict",
      "同键改模式必须冲突",
    );

    const withGrant = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "idem-2",
      input: "带授权范围的任务",
      granted_paths: [{ path: granted, access: "read_write", purpose: "worktree Git 元数据" }],
    });
    assert.equal(withGrant.grantedPaths.length, 1);
    assert.equal(withGrant.grantedPaths[0].path, fs.realpathSync(granted));

    await assert.rejects(
      () =>
        t.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          session_id: sessionId,
          request_id: "idem-2",
          input: "带授权范围的任务",
          granted_paths: [{ path: granted, access: "read", purpose: "worktree Git 元数据" }],
        }),
      (err: any) => err.code === "request_conflict",
      "同键改授权范围必须冲突",
    );

    // 保护目录不得作为授权工作区
    await assert.rejects(
      () =>
        t.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          session_id: sessionId,
          request_id: "idem-3",
          input: "越界授权",
          granted_paths: [{ path: t.dirs.dataDir, access: "read", purpose: "偷看数据目录" }],
        }),
      (err: any) => err.code === "invalid_params",
      "数据目录不得作为授权路径",
    );
  } finally {
    await t.shutdown();
  }
});

test("new Tasks after interruption use the current default or explicit owner access mode", async () => {
  const t = await startTestRuntime("mode-continue", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "cont-1",
      input: "SLOW:长任务",
    });
    await waitFor("任务运行中", async () => (await taskStatus(t.client, task.id)).task.status === "running", 30_000);
    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted", 30_000);

    await assert.rejects(t.client.request("continue", { task_id: task.id, request_id: "retired", input: "old continuation" }), { code: "unknown_op" });
    const continued = await t.client.request<any>("submit", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      request_id: "cont-2",
      input: "继续处理",
    });
    assert.equal(continued.accessMode, "confirm", "继续默认请求确认，旧批准不继承");
    assert.equal(continued.permissionVersion, 1);
    assert.equal(continued.resumesTaskId, null);
    assert.equal(continued.status, "queued");
    assert.equal(t.runtime.getSession(sessionId)!.queuePauseReason, "owner_pause");

    const escalated = await t.client.request<any>("submit", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      request_id: "cont-3",
      input: "继续并以完全访问处理",
      access_mode: "full_access",
    });
    assert.equal(escalated.accessMode, "full_access", "拥有者可在继续时显式选择完全访问");

    await t.client.request("resume_queue", { session_id: sessionId });
    await waitFor("继续的任务完成", async () => (await taskStatus(t.client, escalated.id)).task.status === "completed", 30_000);
  } finally {
    await t.shutdown();
  }
});

test("提交摘要只接受当前格式：模式变化后重试固定任务，显隐式选择仍有区别", async () => {
  const t = await startTestRuntime("mode-digest-current", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    t.runtime.store.withTx(() => t.runtime.store.setSessionQueueState(sessionId, "paused", "test"));
    const model = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
    const params = { session_id: sessionId, request_id: "current-request", input: "原始请求", model_selection: model };
    const task = await t.client.request<any>("submit", params);
    assert.match(task.submissionDigest, /^request-v2:/);
    await t.client.request("switch_mode", { task_id: task.id, mode: "full_access" });
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: 0 });
    const retried = await t.client.request<any>("submit", params);
    assert.equal(retried.id, task.id);
    assert.equal(retried.accessMode, "full_access");
    assert.equal(retried.planMode, false);
    await assert.rejects(t.client.request("submit", { ...params, input: "改变原始请求" }), { code: "request_conflict" });
    const planParams = { ...params, request_id: "plan-request" };
    const plan = await t.client.request<any>("submit", planParams);
    assert.equal(plan.planMode, true);
    await assert.rejects(t.client.request("submit", { ...planParams, access_mode: "plan" }), { code: "request_conflict" });
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: 1 });
    assert.equal((await t.client.request<any>("submit", planParams)).id, plan.id);
    // 旧摘要不能按当前默认值补算权限或变成新的合法提交。
    t.runtime.store.db.prepare("UPDATE tasks SET submission_digest = ? WHERE id = ?").run("legacy-digest", task.id);
    await assert.rejects(t.client.request("submit", params), { code: "request_conflict" });
    assert.equal(t.runtime.store.listTasksBySession(sessionId).length, 2);
  } finally { await t.shutdown(); }
});

test("Plan 默认值与任务固定模式跨后台重启保留，控制面握手恢复真实选择", async () => {
  const t = await startTestRuntime("mode-plan-restart", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    t.runtime.store.withTx(() => t.runtime.store.setSessionQueueState(sessionId, "paused", "test"));
    const model = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: 0 });
    const params = { session_id: sessionId, request_id: "before-restart", input: "完善计划", model_selection: model };
    const plan = await t.client.request<any>("submit", params);
    const ordinary = await t.client.request<any>("submit", { ...params, request_id: "explicit-confirm", access_mode: "confirm" });
    const seq = t.runtime.store.getMaxSeq();
    const instanceId = t.runtime.store.db.getInstanceId();
    await t.runtime.stop("test_restart");
    const runtime = await Runtime.start({
    product: personalProduct.runtime, dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir, socketPath: t.runtime.socketPath(),
      thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: (ctx) => createMockTools(ctx) });
    let client: ControlClient | null = null;
    try {
      await ControlServer.start(runtime);
      client = await connectAuthedClient(runtime);
      const { snapshot, replay } = await client.handshake(seq);
      const restored = snapshot.sessions.find(session => session.id === sessionId)!;
      assert.equal(restored.defaultAccessMode, "plan");
      assert.equal(restored.defaultAccessModeVersion, 1);
      assert.equal(runtime.store.db.getInstanceId(), instanceId);
      const pinned = snapshot.tasks.find(task => task.id === plan.id)!;
      assert.equal(pinned.planMode, true);
      assert.equal(pinned.accessMode, "auto-review");
      assert.equal(pinned.status, "queued");
      assert.equal(snapshot.tasks.find(task => task.id === ordinary.id)!.planMode, false);
      assert.ok(replay.some(event => event.body.type === "backend.stopping"));
      assert.equal((await client.request<any>("submit", params)).id, plan.id);
      const next = await client.request<any>("submit", { ...params, request_id: "after-restart" });
      assert.equal(next.planMode, true);
      assert.equal(next.accessMode, "auto-review");
    } finally { client?.close(); await runtime.stop("test_end"); }
  } finally { await t.shutdown(); }
});

test("CLI mode selection applies to ordinary submissions after explicit queue resume", async () => {
  const t = await startTestRuntime("mode-plan-cli", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    fs.symlinkSync(t.runtime.socketPath(), path.join(t.runtime.controlDir(), "control.sock"));
    const cli = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../apps/ruukoto-code/bin/ruukoto-code.mjs", import.meta.url)), ...args], {
        timeout: 20_000,
        env: { ...process.env, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir,
          RUUKOTO_CODE_CONTROL_DIR: t.runtime.controlDir(), RUUKOTO_CODE_PENDING_DIR: path.join(t.dirs.root, "pending"), RUUKOTO_OWNER_TOKEN: "", RUUKOTO_OWNER_TOKEN_FILE: "" },
      });
      return JSON.parse(stdout);
    };
    assert.equal((await cli("set-session-mode", sessionId, "plan")).defaultAccessMode, "plan");
    const plan = await cli("submit", sessionId, "cli-plan", "--mode", "plan", "QUICK:调研");
    assert.equal(plan.planMode, true);
    assert.equal(plan.accessMode, "auto-review");
    await waitFor("CLI 计划完成", () => t.runtime.store.getTask(plan.id)!.status === "completed");
    const source = await cli("submit", sessionId, "cli-source", "--mode", "confirm", "SLOW:执行");
    await waitFor("CLI 源任务运行", () => t.runtime.store.getTask(source.id)!.status === "running");
    await t.client.request("interrupt", { task_id: source.id });
    assert.equal((await cli("set-session-mode", sessionId, "full_access")).defaultAccessMode, "full_access");
    await assert.rejects(cli("continue", source.id, "cli-retired", "old path"));
    const continued = await cli("submit", sessionId, "cli-continue", "--mode", "plan", "QUICK:重新调研");
    assert.equal(continued.resumesTaskId, null);
    await cli("resume-queue", sessionId);
    assert.equal(continued.planMode, true);
    assert.equal(continued.accessMode, "auto-review");
    assert.equal(continued.permissionVersion, 1);
  } finally { await t.shutdown(); }
});

test("会话默认模式：CAS 更新、新任务固定提交瞬间的默认值、既有任务不改写", async () => {
  const t = await startTestRuntime("session-mode", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const model = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

    // 新会话默认请求确认
    let session = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.equal(session.defaultAccessMode, "confirm");
    assert.equal(session.defaultAccessModeVersion, 0);

    // 非法模式与版本冲突被拒绝，旧值不变
    await assert.rejects(
      t.client.request("set_session_mode", { session_id: sessionId, mode: "autoreview", expected_version: 0 }),
      (err: any) => err.code === "invalid_params",
    );
    await assert.rejects(
      t.client.request("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: 7 }),
      (err: any) => err.code === "default_mode_conflict",
    );
    session = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.equal(session.defaultAccessMode, "confirm");

    // 排队任务固定创建时的模式；切换会话默认值不改写它
    const slow = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "sm-1", input: "SLOW:占位" });
    await waitFor("占位任务运行中", async () => (await taskStatus(t.client, slow.id)).task.status === "running", 30_000);
    const queued = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "sm-2", input: "QUICK:排队" });
    assert.equal(queued.accessMode, "confirm");

    const saved = await t.client.request<any>("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: 0 });
    assert.equal(saved.defaultAccessMode, "full_access");
    assert.equal(saved.defaultAccessModeVersion, 1);
    assert.equal((await taskStatus(t.client, queued.id)).task.accessMode, "confirm", "已排队任务保留创建时的模式");

    // 之后提交且未显式指定模式的新任务沿用会话默认值
    const after = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "sm-3", input: "QUICK:默认模式任务" });
    assert.equal(after.accessMode, "full_access", "新任务固定提交瞬间的会话默认模式");

    // 显式传入的一次性任务模式优先于会话默认值
    const explicit = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "sm-4", input: "QUICK:显式", access_mode: "confirm" });
    assert.equal(explicit.accessMode, "confirm");

    // 同值设置不递增版本
    const same = await t.client.request<any>("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: 1 });
    assert.equal(same.defaultAccessModeVersion, 1);

    await t.client.request("cancel", { task_id: slow.id });
    await waitFor("任务收尾", async () => {
      const statuses = await Promise.all([slow, queued, after, explicit].map((task) => taskStatus(t.client, task.id)));
      return statuses.every((item) => ["completed", "canceled"].includes(item.task.status));
    }, 30_000);
  } finally {
    await t.shutdown();
  }
});

test("会话默认模式支持 auto-review：CAS 接受、任务固定、显式覆盖、任务级切换、跨重启保留", async () => {
  const t = await startTestRuntime("mode-autoreview", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const model = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

    // auto-review 是合法模式：CAS 成功、版本递增
    const saved = await t.client.request<any>("set_session_mode", { session_id: sessionId, mode: "auto-review", expected_version: 0 });
    assert.equal(saved.defaultAccessMode, "auto-review");
    assert.equal(saved.defaultAccessModeVersion, 1);

    // 新任务固定提交瞬间的会话默认模式
    const pinned = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "ar-1", input: "QUICK:自动审查任务" });
    assert.equal(pinned.accessMode, "auto-review");

    // 显式传入的一次性任务模式优先于会话默认值
    const explicit = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "ar-2", input: "QUICK:显式", access_mode: "confirm" });
    assert.equal(explicit.accessMode, "confirm");
    await waitFor("两个任务完成", async () => {
      const a = (await taskStatus(t.client, pinned.id)).task.status;
      const b = (await taskStatus(t.client, explicit.id)).task.status;
      return a === "completed" && b === "completed";
    }, 60_000);

    // 排队任务可经 switch_mode 切到 auto-review（无执行中工具的边界立即生效）
    const slow = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "ar-3", input: "SLOW:占位" });
    await waitFor("占位任务运行中", async () => (await taskStatus(t.client, slow.id)).task.status === "running", 30_000);
    const queued = await t.client.request<any>("submit", { model_selection: model, session_id: sessionId, request_id: "ar-4", input: "QUICK:排队", access_mode: "confirm" });
    assert.equal(queued.accessMode, "confirm");
    const switched = await t.client.request<any>("switch_mode", { task_id: queued.id, mode: "auto-review" });
    assert.equal(switched.accessMode, "auto-review");
    assert.equal(switched.permissionVersion, 2, "切换递增权限版本");
    await t.client.request("cancel", { task_id: slow.id });
    await waitFor("任务收尾", async () => {
      const a = (await taskStatus(t.client, slow.id)).task.status;
      const b = (await taskStatus(t.client, queued.id)).task.status;
      return ["canceled", "completed"].includes(a) && b === "completed";
    }, 60_000);

    // 跨重启保留会话默认值
    await t.runtime.stop("test_restart");
    const { Runtime } = await import("@ruukoto/runtime/runtime.ts");
    const runtime2 = await Runtime.start({
    product: personalProduct.runtime,
      dataDir: t.dirs.dataDir,
      agentDir: t.dirs.agentDir,
      socketPath: t.runtime.socketPath(),
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      toolFactory: (ctx) => createMockTools(ctx),
    });
    try {
      assert.equal(runtime2.store.getSession(sessionId)!.defaultAccessMode, "auto-review", "重启后保留会话默认模式");
    } finally {
      await runtime2.stop("test_end");
    }
  } finally {
    await t.shutdown();
  }
});

test("switch-mode 在无执行中工具的边界生效；任务结束后拒绝切换", async () => {
  const t = await startTestRuntime("mode-switch", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const running = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "sw-1",
      input: "SLOW:占住会话",
    });
    await waitFor("任务运行中", async () => (await taskStatus(t.client, running.id)).task.status === "running", 30_000);
    const queued = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "sw-2",
      input: "QUICK:排队任务",
    });
    assert.equal((await taskStatus(t.client, queued.id)).task.status, "queued");

    const switched = await t.client.request<any>("switch_mode", { task_id: queued.id, mode: "full_access" });
    assert.equal(switched.accessMode, "full_access", "排队任务在无执行中工具时立即切换");
    assert.equal(switched.permissionVersion, 2, "切换递增权限版本");
    assert.equal(switched.pendingAccessMode, null);

    const handshake = await t.client.handshake();
    const events = t.runtime.getEventLog(0, 10_000);
    assert.ok(
      events.some((e) => e.body.type === "task.mode_switched" && e.taskId === queued.id),
      "应记录模式切换事件",
    );
    assert.ok(handshake.snapshot.tasks.find((x: any) => x.id === queued.id)?.accessMode === "full_access");

    await assert.rejects(
      () => t.client.request("switch_mode", { task_id: queued.id, mode: "full_access" }),
      (err: any) => err.code === "invalid_state",
      "已是该模式时拒绝重复切换",
    );

    await waitFor("两个任务完成", async () => {
      const a = (await taskStatus(t.client, running.id)).task.status;
      const b = (await taskStatus(t.client, queued.id)).task.status;
      return a === "completed" && b === "completed";
    }, 60_000);

    await assert.rejects(
      () => t.client.request("switch_mode", { task_id: queued.id, mode: "confirm" }),
      (err: any) => err.code === "invalid_state",
      "已结束的任务不得切换模式",
    );
  } finally {
    await t.shutdown();
  }
});

test("完全访问任务不逐次确认；缺少执行入口时不静默降级", async () => {
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "fa_bash", name: "bash", arguments: { command: "echo full-access-ran > fa.txt" } }],
      };
    }
    return { kind: "text", text: "完全访问任务完成" };
  };
  const t = await startTestRuntime("mode-full", responder, { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "fa-1",
      input: "以完全访问执行",
      access_mode: "full_access",
    });
    assert.equal(task.accessMode, "full_access");
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "fa.txt"), "utf8").trim(), "full-access-ran");
    const detail = await taskStatus(t.client, task.id);
    assert.equal(detail.confirmations.length, 0, "完全访问不逐次确认");

    // 后续任务仍默认请求确认（模式按任务生效，不继承）
    const next = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "fa-2",
      input: "普通任务",
    });
    assert.equal(next.accessMode, "confirm");
  } finally {
    await t.shutdown();
  }

  // 受限原生入口不可用不妨碍完全访问使用启动账户。
  const strict = await startTestRuntime("mode-full-nobackend", () => ({ kind: "text", text: "noop" }), {
    workDirs: 1, config: { execution: { backend: "native", native: { workerPath: "/missing/ruukoto-worker.mjs" } } },
  });
  try {
    const { sessionId } = await createProjectSession(strict.client, strict.work[0]!);
    const task = await strict.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId, request_id: "fa-3", input: "以完全访问执行", access_mode: "full_access",
    });
    assert.equal(task.accessMode, "full_access");
    await waitFor("任务完成", async () => (await taskStatus(strict.client, task.id)).task.status === "completed", 60_000);
  } finally {
    await strict.shutdown();
  }
});

test("完全访问直接选择当前账户启动器，受限原生入口仍不降级", () => {
  assert.equal(createLauncherFor({ backend: "local" }, "full_access").kind, "local");
  assert.equal(createLauncherFor({ backend: "native" }, "full_access").kind, "local");
  assert.equal(createLauncherFor({ backend: "native" }, "confirm").kind, "native");
});

test("控制面拥有者认证：认证前不返回快照、不执行请求", async () => {
  const t = await startTestRuntime("owner-auth", modeRoutes(), { workDirs: 1 });
  try {
    const controlDir = t.runtime.controlDir();
    const tokenPath = path.join(controlDir, TOKEN_FILE_NAME);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600, "令牌文件权限 0600");

    const raw = await ControlClient.connect(t.runtime.socketPath());
    try {
      await assert.rejects(() => raw.request("ping"), (err: any) => err.code === "unauthorized");
      await assert.rejects(() => raw.handshake(), (err: any) => err.code === "unauthorized", "认证前不得取快照");
      await assert.rejects(
        () => raw.request("create_project", { name: "nope" }),
        (err: any) => err.code === "unauthorized",
        "认证前不得执行请求",
      );
      await assert.rejects(
        () => raw.authenticate("00000000000000000000000000000000000000000000000000000000000000ff"),
        (err: any) => err.code === "unauthorized",
        "错误令牌被拒绝",
      );
      const token = readOwnerToken(controlDir)!;
      await raw.authenticate(token);
      const snapshot = await raw.handshake();
      assert.ok(Array.isArray(snapshot.snapshot.projects));
    } finally {
      raw.close();
    }
  } finally {
    await t.shutdown();
  }
});

test("模型不能提升任务模式：不存在这种工具", async () => {  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [
          { id: "esc_1", name: "switch_mode", arguments: { task_id: "self", mode: "full_access" } },
          { id: "esc_2", name: "respond_confirmation", arguments: { confirmation_id: "x", decision: "approve" } },
        ],
      };
    }
    return { kind: "text", text: "无法提升，按请求确认继续" };
  };
  const t = await startTestRuntime("mode-escalate", responder, { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "esc-1",
      input: "尝试提升模式",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);
    const detail = await taskStatus(t.client, task.id);
    assert.equal(detail.task.accessMode, "confirm", "任务模式不得被模型改动");
    assert.equal(detail.task.permissionVersion, 1, "权限版本不得被模型改动");
    assert.equal(detail.confirmations.length, 0, "模型不能伪造批准");
    for (const op of detail.toolOps) {
      assert.equal(op.isError, true, `${op.toolName} 不是可用工具，必须被拒绝`);
    }
  } finally {
    await t.shutdown();
  }
});

test("保护根双向排除：受限任务授予保护根的祖先或服务代码目录被拒绝", async () => {
  const t = await startTestRuntime("protected-roots", modeRoutes(), { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 授予数据目录的父目录（保护根的祖先）——会把受保护内容挂进边界，必须拒绝
    await assert.rejects(
      () =>
        t.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          session_id: sessionId,
          request_id: "prot-1",
          input: "授予父目录",
          granted_paths: [{ path: t.dirs.root, access: "read", purpose: "绕过保护" }],
        }),
      (err: any) => err.code === "invalid_params",
      "授予保护根的祖先目录必须被拒绝",
    );
    // 授予服务代码目录（服务代码本身不可作为授权范围）
    await assert.rejects(
      () =>
        t.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          session_id: sessionId,
          request_id: "prot-2",
          input: "授予服务代码",
          granted_paths: [{ path: process.cwd(), access: "read_write", purpose: "改服务代码" }],
        }),
      (err: any) => err.code === "invalid_params",
      "服务代码目录不得作为授予路径",
    );

  } finally {
    await t.shutdown();
  }
});

test("assertGrantNotProtected：根目录视为所有保护根的祖先", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-grant-parent-")));
  const protectedRoot = path.join(root, "protected");
  const work = path.join(root, "work");
  try {
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(work);
    assert.throws(() => assertGrantNotProtected(path.parse(root).root, [protectedRoot]), /父级/);
    assert.throws(() => assertGrantNotProtected(root, [protectedRoot]), /父级/);
    assert.doesNotThrow(() => assertGrantNotProtected(work, [protectedRoot]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Git worktree：授予共享 Git 元数据时用途标注其影响；不授予则不自动包含", async () => {
  const t = await startTestRuntime("worktree", modeRoutes(), { workDirs: 0 });
  try {
    // 真实仓库 + worktree
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-wt-main-")));
    const wt = path.join(repo, "..", `${path.basename(repo)}-wt`);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wt-branch"], { cwd: repo });
    const wtReal = fs.realpathSync(wt);
    const commonGit = fs.realpathSync(path.join(repo, ".git"));

    const { sessionId } = await createProjectSession(t.client, wtReal);
    // 不授予：任务照常成立，但 grantedPaths 为空——共享 Git 元数据不被自动挂载
    const plain = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "wt-1",
      input: "QUICK:worktree 任务",
    });
    assert.equal(plain.grantedPaths.length, 0, "不授予就不自动挂载主仓库或父目录");

    // 授予 worktree 的共享 Git 目录：用途自动标注共享 Git 元数据的影响
    const withGrant = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "wt-2",
      input: "QUICK:worktree 元数据任务",
      granted_paths: [{ path: commonGit, access: "read_write", purpose: "worktree Git 元数据" }],
    });
    assert.match(
      withGrant.grantedPaths[0].purpose,
      /共享 Git 元数据/,
      "授予覆盖 worktree 共享 Git 目录时展示其影响",
    );
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo });
    fs.rmSync(repo, { recursive: true, force: true });
  } finally {
    await t.shutdown();
  }
});


test("拥有者登记保护目录、祖先与新会话不查询 Agent 保护范围", async () => {
  const t = await startTestRuntime("owner-register", () => ({ kind: "text", text: "不会调用模型" }));
  const protectedRoots = t.runtime.protectedRoots;
  try {
    t.runtime.protectedRoots = () => { throw new Error("拥有者登记不应计算保护范围"); };
    for (const cwd of [t.dirs.dataDir, t.dirs.root, process.cwd()]) {
      const opened = await t.runtime.openWorkspace({ cwd, mode: "full_access" });
      assert.equal(opened.session.cwdReal, fs.realpathSync(cwd));
      const session = await t.runtime.createSession({ projectId: opened.session.projectId, cwd, mode: "confirm" });
      assert.equal(session.defaultAccessMode, "confirm", "登记不取决于会话的后续任务模式");
    }
    assert.equal(t.server.calls.length, 0);
  } finally { t.runtime.protectedRoots = protectedRoots; await t.shutdown(); }
});

test("受限 local 启动前核实工作区、授予路径和只读根", async () => {
  const t = await startTestRuntime("owner-local-guard", () => ({ kind: "text", text: "不会调用模型" }));
  try {
    const spec: LaunchSpec = { taskId: "local-guard", mode: "confirm", workspace: fs.realpathSync(t.work[0]!), grantedPaths: [] };
    const protectedRoot = fs.realpathSync(t.dirs.dataDir);
    const cases: LaunchSpec[] = [
      { ...spec, workspace: protectedRoot },
      { ...spec, workspace: fs.realpathSync(t.dirs.root) },
      { ...spec, grantedPaths: [{ path: protectedRoot, access: "read", purpose: "受限资料" }] },
      { ...spec, readRoots: [{ path: protectedRoot }] },
    ];
    for (const input of cases) await assert.rejects(async () => {
      const unit = await t.runtime.launcherFor("confirm").launch(input);
      await unit.entry.stop();
    }, (error: unknown) => error instanceof ExecutionError && error.code === "execution_unavailable" && error.reason === "sandbox_rejected");
    assert.equal(t.server.calls.length, 0);
  } finally { await t.shutdown(); }
});

test("保护目录的完全访问真实读取成功，运行中切为受限后不能复用旧 worker", async () => {
  let release!: () => void;
  const continueModel = new Promise<void>(resolve => { release = resolve; });
  let firstRead = false;
  const t = await startTestRuntime("owner-mode-switch", async req => {
    const results = req.messages.filter(message => message.role === "tool");
    if (results.length === 1) { firstRead = true; await continueModel; }
    return results.length < 2 ? { kind: "tool_calls", calls: [{ id: `read-${results.length}`, name: "read", arguments: { path: "owner-sentinel.txt" } }] } : { kind: "text", text: "已报告读取结果" };
  }, { config: realTools() });
  try {
    fs.writeFileSync(path.join(t.dirs.dataDir, "owner-sentinel.txt"), "owner-sentinel-visible");
    const session = (await t.runtime.openWorkspace({ cwd: t.dirs.dataDir, mode: "full_access" })).session;
    const task = await t.runtime.submit({ sessionId: session.id, requestId: "read-then-restrict", input: "读取测试文件", modelSelection: t.runtime.defaultSelection });
    await waitFor("完全访问已实际读取文件", () => firstRead, 30_000);
    const before = t.runtime.store.listToolOpsByTask(task.id);
    assert.equal(before[0]!.isError, false);
    assert.match(before[0]!.resultSummary!, /owner-sentinel-visible/);
    await t.runtime.switchTaskMode({ taskId: task.id, mode: "confirm" });
    release();
    await waitFor("受限读取结果已落盘", () => t.runtime.store.getTask(task.id)!.status === "completed", 30_000);
    const after = t.runtime.store.listToolOpsByTask(task.id);
    assert.equal(after.length, 2);
    assert.equal(after[1]!.isError, true);
    assert.doesNotMatch(after[1]!.resultSummary!, /owner-sentinel-visible/);
    assert.match(JSON.stringify(t.server.calls.at(-1)!.messages.at(-1)), /停止本轮并向拥有者报告工作目录与授权范围/);
    assert.equal(t.runtime.store.getTask(task.id)!.accessMode, "confirm");
    assert.equal(t.runtime.store.listConfirmationsByTask(task.id).length, 0);
    assert.deepEqual(t.runtime.store.listAllOccupancy(), []);
  } finally { release(); await t.shutdown(); }
});
