/**
 * 集成：访问模式绑定任务与拥有者入口（issue 03 §2/§5/§6.3/§6.4）。
 *
 * 覆盖：
 * - 提交幂等比较包含模式与授权范围：同键同参返回原任务，改模式/改范围必须冲突；
 * - continue 新建任务默认请求确认，拥有者可在提交时显式选择完全访问；
 * - switch-mode 在无执行中工具的边界生效（权限版本递增并发出事件），
 *   任务结束后拒绝切换；
 * - 完全访问任务不逐次确认（本地开发后端）且不改动其他任务的模式；
 * - 缺少执行入口时完全访问明确失败，不静默降级；
 * - 控制面拥有者认证：认证前不返回快照、不执行请求；
 * - 模型不能提升模式（不存在这种工具）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  startTestRuntime,
  routeResponder,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
  realTools,
} from "./helpers/testkit.ts";
import { ControlClient } from "../src/control/client.ts";
import { readOwnerToken, TOKEN_FILE_NAME } from "../src/control/owner-token.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
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

test("continue 新任务默认请求确认，拥有者可显式选择完全访问", async () => {
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

    const continued = await t.client.request<any>("continue", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      task_id: task.id,
      request_id: "cont-2",
      input: "继续处理",
    });
    assert.equal(continued.accessMode, "confirm", "继续默认请求确认，旧批准不继承");
    assert.equal(continued.permissionVersion, 1);
    assert.equal(continued.resumesTaskId, task.id);

    const escalated = await t.client.request<any>("continue", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      task_id: task.id,
      request_id: "cont-3",
      input: "继续并以完全访问处理",
      access_mode: "full_access",
    });
    assert.equal(escalated.accessMode, "full_access", "拥有者可在继续时显式选择完全访问");

    await waitFor("继续的任务完成", async () => (await taskStatus(t.client, escalated.id)).task.status === "completed", 30_000);
  } finally {
    await t.shutdown();
  }
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
    const { Runtime } = await import("../src/runtime/runtime.ts");
    const runtime2 = await Runtime.start({
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

  // 缺少执行账户入口：完全访问提交明确失败，不回退到 local/后台账户
  const strict = await startTestRuntime("mode-full-nobackend", () => ({ kind: "text", text: "noop" }), {
    workDirs: 1,
    config: { execution: { backend: "container" } },
  });
  try {
    const { sessionId } = await createProjectSession(strict.client, strict.work[0]!);
    await assert.rejects(
      () =>
        strict.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          session_id: sessionId,
          request_id: "fa-3",
          input: "以完全访问执行",
          access_mode: "full_access",
        }),
      (err: any) => err.code === "execution_unavailable",
      "缺少执行入口必须明确失败",
    );
  } finally {
    await strict.shutdown();
  }
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

test("保护根双向排除：授予保护根的祖先或服务代码目录被拒绝；工作区同样受限", async () => {
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
    // 工作区本身不得是保护根（数据目录）
    const project2 = await t.client.request<any>("create_project", { name: "prot-ws" });
    await assert.rejects(
      () =>
        t.client.request("create_session", {
          project_id: project2.id,
          cwd: t.dirs.dataDir,
        }),
      (err: any) => err.code === "invalid_params",
      "数据目录不得作为会话工作区",
    );
    await assert.rejects(
      () =>
        t.client.request("create_session", {
          project_id: project2.id,
          cwd: t.dirs.root,
        }),
      (err: any) => err.code === "invalid_params",
      "保护根的祖先目录不得作为会话工作区",
    );
  } finally {
    await t.shutdown();
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
