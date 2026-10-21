import type { TaskView as Task } from "@ruukoto/core/views.ts";
/**
 * 控制面接缝（架构工单 07）：TUI 的 op 表与服务端一致；请求失败的分类由产生错误的
 * 地方写定；TUI 按分类处理应答丢失（替身 + 假终端，不起后台）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ControlClient, ControlClientError, requestOutcome } from "@ruukoto/control/client.ts";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { CONTROL_PROTOCOL_VERSION, MAX_FRAME_BYTES, type ControlResponse } from "@ruukoto/control/protocol.ts";
import { errorReply } from "@ruukoto/control/server.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { ensureWorkspaceSession } from "@ruukoto/control/workspace.ts";
import type { ConfirmationRequest, Project, Session, SessionCompactionRequest } from "@ruukoto/core/types.ts";
import { confirmationToView } from "@ruukoto/core/views.ts";
import { TuiApp } from "@ruukoto/tui/tui/app.ts";
import { CommandHistoryStore } from "@ruukoto/tui/tui/command-history.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { fakeControl, fakeSnapshot, type FakeHandlers, type FakeScript } from "./helpers/fake-control.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import { createProjectSession, routeResponder, startTestRuntime, waitFor } from "./helpers/testkit.ts";

// ---------- op 表 ----------

/** 与 TuiOps 的键一一对应（多写、少写都过不了类型检查）。 */
const TUI_OPS: Record<TuiOp, true> = {
  get_model_config: true, save_model_catalog: true, set_model_api_key: true, remove_model_api_key: true,
  remove_model_provider: true, set_default_model: true, set_summary_model: true, test_model_connection: true,
  mcp_sources: true, mcp_list: true, mcp_configure: true, mcp_set_enabled: true, mcp_remove: true, mcp_check: true,
  mcp_save_credential: true, mcp_remove_credential: true, list_credentials: true, remove_credential: true,
  put_attachment: true,
  list_workspace_files: true, read_workspace_file: true, read_workspace_git: true,
  work_list: true, work_get: true,
  workflow_get: true, workflow_question: true, workflow_answer: true,
  workflow_definitions: true, workflow_definition: true, workflow_save: true, workflow_saved: true, workflow_start: true, workflow_find: true,
  workflow_list: true, workflow_step: true, workflow_logs: true, workflow_control: true, workflow_receipt: true,
  get_session_todos: true, branch_session: true, find_branch_session: true,
  compact_session: true, get_session_compaction: true, interrupt_session_compaction: true,
  get_task: true, find_task: true, list_tasks: true, read_task_events: true, read_history: true, read_tool_result: true, read_history_entry: true,
  get_tool_op_params: true, get_confirmation_params: true, read_artifact: true, get_session_usage: true, get_session: true, list_session_summaries: true, list_models: true,
  set_session_model: true, set_session_mode: true, set_session_archived: true, create_project: true, create_session: true, open_workspace: true, submit: true, continue: true,
  interrupt: true, cancel: true, resume_queue: true, respond_confirmation: true, list_selection_records: true,
  get_context_breakdown: true, list_prompt_requests: true, read_prompt_snapshot: true, search_history: true, list_skills: true, list_subagent_roles: true,
  skills_list: true, skill_get: true, skill_import_preview: true, skill_import: true, skill_set_enabled: true, skill_remove: true,
  list_memories: true, get_memory: true, revoke_memory: true, restore_memory: true, qq_status: true, qq_set_enabled: true,
  qq_inbox_list: true, qq_outbox_list: true,
};

test("op 表：表里每个 op 服务端都认得（空参数只会被参数校验拒绝，不回 unknown_op）", async () => {
  const t = await startTestRuntime("tui-ops", routeResponder([]));
  try {
    for (const op of Object.keys(TUI_OPS)) {
      const code = await t.client.request(op, {}).then(() => null, (err: { code?: string }) => err.code);
      assert.notEqual(code, "unknown_op", op);
    }
  } finally {
    await t.shutdown();
  }
});

test("技能管理控制面：预览提交、启停与逻辑移除读回，保留外部源和旧正文", async () => {
  const t = await startTestRuntime("managed-skill-ops", routeResponder([]));
  try {
    const source = path.join(fs.realpathSync(t.dirs.root), "controlled-skill"), raw = "---\nname: controlled-skill\ndescription: 控制面技能\ndisable-model-invocation: true\n---\nCONTROLLED-SKILL-BODY\n";
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "SKILL.md"), raw);
    const preview = await t.client.request<OpResult<"skill_import_preview">>("skill_import_preview", { source_dir: source });
    assert.equal(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"), raw);
    assert.equal((await t.client.request<OpResult<"list_skills">>("list_skills", {})).skills.length, 0, "预览不安装");
    await t.client.request<OpResult<"skill_import">>("skill_import", { skill_id: preview.id, source_dir: preview.sourceDir, content_revision: preview.contentRevision, expected_revision: preview.revision });
    let legacy = await t.client.request<OpResult<"list_skills">>("list_skills", {});
    assert.deepEqual(legacy.skills.map(skill => [skill.name, skill.explicitOnly]), [["controlled-skill", true]], "仅显式调用仍可供拥有者选择");
    assert.match(JSON.stringify(await t.client.request<OpResult<"skill_get">>("skill_get", { skill_id: preview.id })), /CONTROLLED-SKILL-BODY/);
    let current = await t.client.request<OpResult<"skills_list">>("skills_list", { offset: 0, limit: 1 });
    await t.client.request<OpResult<"skill_set_enabled">>("skill_set_enabled", { skill_id: preview.id, enabled: false, expected_revision: current.revision });
    assert.equal((await t.client.request<OpResult<"list_skills">>("list_skills", {})).skills.length, 0);
    assert.match(JSON.stringify(await t.client.request<OpResult<"skill_get">>("skill_get", { skill_id: preview.id })), /disabled/);
    current = await t.client.request<OpResult<"skills_list">>("skills_list", {});
    await t.client.request<OpResult<"skill_set_enabled">>("skill_set_enabled", { skill_id: preview.id, enabled: true, expected_revision: current.revision });
    legacy = await t.client.request<OpResult<"list_skills">>("list_skills", {});
    assert.equal(legacy.skills[0]?.name, "controlled-skill");
    current = await t.client.request<OpResult<"skills_list">>("skills_list", {});
    await t.client.request<OpResult<"skill_remove">>("skill_remove", { skill_id: preview.id, expected_revision: current.revision });
    assert.equal((await t.client.request<OpResult<"list_skills">>("list_skills", {})).skills.length, 0);
    assert.match(JSON.stringify(await t.client.request<OpResult<"skill_get">>("skill_get", { skill_id: preview.id })), /CONTROLLED-SKILL-BODY/, "逻辑移除仍可按原身份读回");
    assert.equal(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"), raw, "管理不改外部源");
  } finally {
    await t.shutdown();
  }
});

test("技能管理参数：拒绝越界分页、未知字段与缺失修订，不开放任意文件操作", async () => {
  const t = await startTestRuntime("managed-skill-params", routeResponder([]));
  try {
    const requests: Array<[TuiOp, Record<string, unknown>]> = [
      ["skills_list", { offset: -1 }], ["skills_list", { limit: 101 }], ["skills_list", { limit: "1" }],
      ["skill_get", { skill_id: "selected", path: "secret" }],
      ["skill_import_preview", { source_dir: "/selected", command: "run" }],
      ["skill_import", { skill_id: "selected", source_dir: "/selected", content_revision: "revision" }],
      ["skill_set_enabled", { skill_id: "selected", enabled: "false", expected_revision: "revision" }],
      ["skill_remove", { skill_id: "selected", expected_revision: "revision", recursive: true }],
    ];
    for (const [op, params] of requests) {
      const code = await t.client.request(op, params).then(() => null, (error: { code?: string }) => error.code);
      assert.equal(code, "invalid_params", op);
    }
  } finally {
    await t.shutdown();
  }
});

test("真实控制面在认证前按协议版本方向提示更新客户端或重开旧后台", async () => {
  const runtime = await startTestRuntime("ctl-version", routeResponder([]));
  try {
    for (const version of [CONTROL_PROTOCOL_VERSION - 1, CONTROL_PROTOCOL_VERSION + 1]) {
      const socket = net.connect(runtime.runtime.socketPath());
      socket.setEncoding("utf8");
      try {
        const response = await new Promise<ControlResponse>((resolve, reject) => {
          let buffer = "";
          socket.once("error", reject);
          socket.on("data", (chunk: string) => {
            buffer += chunk;
            const index = buffer.indexOf("\n");
            if (index !== -1) resolve(JSON.parse(buffer.slice(0, index)) as ControlResponse);
          });
          socket.once("connect", () => socket.write(`${JSON.stringify({ v: version, id: "mismatch", op: "connect" })}\n`));
        });
        assert.equal(response.v, CONTROL_PROTOCOL_VERSION);
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, "protocol_version", "未认证也先拒绝版本不匹配");
        assert.match(response.error!.message, new RegExp(`服务端 v${CONTROL_PROTOCOL_VERSION}，请求 v${version}`));
        if (version < CONTROL_PROTOCOL_VERSION) {
          assert.match(response.error!.message, /升级客户端/);
          assert.doesNotMatch(response.error!.message, /结束旧后台/);
        } else {
          assert.match(response.error!.message, /后台版本较旧.*结束旧后台进程后重开/);
          assert.doesNotMatch(response.error!.message, /升级客户端/);
        }
      } finally {
        socket.destroy();
      }
    }
  } finally {
    await runtime.shutdown();
  }
});

// ---------- 分类：产生处写定 ----------

/** 桩服务端：按请求的 op 名决定怎样应答（或不应答）。 */
async function stubServer(): Promise<{ socketPath: string; close(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-stub-"));
  const socketPath = path.join(dir, "s.sock");
  const reply = (socket: net.Socket, id: string, code: string) =>
    socket.write(`${JSON.stringify({ v: 1, id, ok: false, error: { code, message: code } })}\n`);
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const { id, op } = JSON.parse(buffer.slice(0, i)) as { id: string; op: string };
        buffer = buffer.slice(i + 1);
        if (op === "hang") continue;
        if (op === "destroy") socket.destroy();
        else if (op === "bad_json") socket.write("not json\n");
        else if (op === "partial") socket.end('{"id":');
        else if (op === "huge") socket.write("x".repeat(MAX_FRAME_BYTES + 1));
        else reply(socket, id, op);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<[string, string]> {
  const err = await promise.then(
    () => assert.fail("应当失败"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ControlClientError);
  return [err.code, err.outcome];
}

test("分类：服务端错误应答、超时、各种断线、发送前失败各在产生处写定", async () => {
  const stub = await stubServer();
  const clients: ControlClient[] = [];
  const connect = async () => {
    const client = await ControlClient.connect(stub.socketPath);
    clients.push(client);
    return client;
  };
  try {
    const c = await connect();
    assert.deepEqual(await failure(c.request("invalid_params")), ["invalid_params", "rejected"]);
    assert.deepEqual(await failure(c.request("request_conflict")), ["request_conflict", "rejected"]);
    for (const code of ["internal_error", "response_too_large", "mode_switch_unverified"]) {
      assert.deepEqual(await failure(c.request(code)), [code, "unknown"], code);
    }
    assert.deepEqual(await failure(c.request("hang", {}, 30)), ["request_timeout", "unknown"]);
    assert.deepEqual(await failure(c.request("x", { n: 1n })), ["invalid_params", "not_sent"], "参数无法序列化");

    // 断线：在途请求应答丢失（每种一条新连接）
    for (const [op, code] of [["destroy", "connection_closed"], ["bad_json", "bad_frame"], ["partial", "unterminated_frame"], ["huge", "frame_too_large"]]) {
      assert.deepEqual(await failure((await connect()).request(op!)), [code, "disconnected"], op);
    }
    const closing = await connect();
    const inflight = closing.request("hang");
    closing.close();
    assert.deepEqual(await failure(inflight), ["closed", "disconnected"], "主动关闭时的在途请求");
    assert.deepEqual(await failure(closing.request("x")), ["closed", "not_sent"], "关闭后再发");

    assert.deepEqual(await failure(ControlClient.connect(path.join(os.tmpdir(), "no-such-ruukoto.sock"))), ["connection_error", "not_sent"]);
    const idle = new ControlConnection({ socketPath: stub.socketPath, token: "t" }, { onState() {}, onSnapshot() {}, onEvent() {} });
    assert.deepEqual(await failure(idle.request("get_session", { session_id: "s" })), ["connection_unavailable", "not_sent"]);
    const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-idle-"));
    const guardStore = new PendingRequestStore(guardDir);
    const beforeHandshake = new SubmissionGuard(guardStore, idle).submit("submit", { session_id: "s", input: "x" });
    assert.deepEqual(await failure(beforeHandshake), ["connection_unavailable", "not_sent"], "握手前提交");
    assert.equal(guardStore.list().records.length, 0, "握手前提交不落盘");
    fs.rmSync(guardDir, { recursive: true, force: true });
    assert.equal(requestOutcome(new TypeError("bug")), "unknown", "非 ControlClientError 保守按应答丢失");
  } finally {
    for (const client of clients) client.close();
    await stub.close();
  }
});

test("服务端错误应答：业务码原样，系统码与没带码的异常收口为 internal_error", () => {
  assert.deepEqual(errorReply(Object.assign(new Error("版本冲突"), { code: "default_mode_conflict" })), { code: "default_mode_conflict", message: "版本冲突" });
  assert.deepEqual(errorReply(Object.assign(new Error("no such file"), { code: "ENOENT" })), { code: "internal_error", message: "ENOENT：no such file" });
  assert.deepEqual(errorReply(Object.assign(new Error("disk I/O"), { code: "ERR_SQLITE_ERROR" })), { code: "internal_error", message: "ERR_SQLITE_ERROR：disk I/O" });
  assert.deepEqual(errorReply(new TypeError("x is undefined")), { code: "internal_error", message: "x is undefined" });
});

// ---------- TUI：按分类处理应答丢失（替身 + 假终端） ----------

const T0 = "2026-09-27T00:00:00.000Z";
const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;
const PROJECT: Project = { id: "proj_fake", name: "fake", createRequestId: null, rootDir: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: T0 };

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_fake", projectId: PROJECT.id, workspaceProjectId: null,
    name: null,
    branchSource: null, kind: "dev", cwd: os.tmpdir(), cwdReal: os.tmpdir(), cwdDev: 0, cwdIno: 0,
    piSessionId: "pi_fake", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: { ...MODEL },
    modelSelectionVersion: 1, defaultAccessMode: "confirm", defaultAccessModeVersion: 1, queueState: "active",
    queuePauseReason: null, archivedAt: null, createdAt: T0, ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_fake", sessionId: "sess_fake", requestId: "req_fake", input: "输入", inputPurpose: "user", modelSelection: { ...MODEL },
    submissionDigest: null, status: "queued", accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [],
    pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null,
    historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null,
    resultSummary: null, resultRef: null,
    workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: T0, startedAt: null, endedAt: null, ...overrides,
  };
}

const CONFIRMATION: ConfirmationRequest = {
  id: "conf_fake", taskId: "task_fake", sessionId: "sess_fake", toolOpId: "toolop_fake", toolName: "mock_gate",
  params: { note: "批准我" }, scope: { kind: "tool", workspaceOnly: true }, cwdDev: 0, cwdIno: 0, permissionVersion: 1,
  status: "pending", createdAt: T0, respondedAt: null, consumedAt: null, reviewStatus: null, reviewDecision: null,
  reviewReason: null, reviewModel: null, reviewPolicyVersion: null, decisionSource: null, standingPermissionId: null, standingPermissionVersion: null,
};

/** 待审批任务的快照与详情应答（审批用例共用）。 */
function approvalScript(respond: FakeHandlers["respond_confirmation"], status: ConfirmationRequest["status"] = "pending") {
  const { params: _params, ...rest } = CONFIRMATION;
  const awaiting = task({ status: "awaiting_confirmation" });
  return {
    snapshot: { tasks: [awaiting], confirmations: [confirmationToView(CONFIRMATION)] },
    handlers: {
      get_confirmation_params: () => ({ confirmation: rest, params: { text: '{"note":"批准我"}', offset: 0, totalBytes: 17, truncated: false } }),
      get_task: () => ({ seq: 0, task: awaiting, toolOps: [], confirmations: [confirmationToView({ ...CONFIRMATION, status })], artifacts: [], outputPreview: null }),
      respond_confirmation: respond,
    } satisfies FakeHandlers,
  };
}

async function openApproval(h: Awaited<ReturnType<typeof startFakeApp>>): Promise<void> {
  h.terminal.send("/approvals\r");
  await new Promise((r) => setTimeout(r, 80));
  h.terminal.send("\r");
  await waitFor("审批详情", () => h.terminal.output().includes("批准我"));
  h.terminal.send("a");
}

/** 启动时 TUI 会读的只读 op：给空结果。 */
const QUIET: FakeHandlers = {
  read_history: () => ({ fileAvailable: true, hasPartialTail: false, entries: [], nextBefore: null }),
  list_tasks: () => ({ tasks: [], hasMore: false }),
  get_session_compaction: () => null,
};

async function startFakeApp(
  script: FakeScript & { snapshot?: Parameters<typeof fakeSnapshot>[0] },
  opts: { workspace?: { path: string }; seed?: (store: PendingRequestStore) => void; commandHistory?: true } = {},
) {
  const ctl = fakeControl({
    handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ projects: [PROJECT], sessions: [session()], ...script.snapshot }) }),
    ...script,
    handlers: { ...QUIET, ...script.handlers },
  });
  let app: TuiApp | null = null;
  const connection = new ControlConnection(
    { socketPath: "(fake)", token: "t", clientFactory: ctl.factory, reconnectInitialMs: 20, reconnectMaxMs: 40 },
    {
      onState: (s, detail) => app?.onConnectionState(s, detail),
      onSnapshot: (result, ctx) => app?.onSnapshot(result, ctx),
      onEvent: (event, kind) => app?.onEvent(event, kind),
    },
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-fake-"));
  const pendingStore = new PendingRequestStore(dir);
  opts.seed?.(pendingStore);
  const state = new ViewState(opts.commandHistory ? new CommandHistoryStore(path.join(dir, "commands.sqlite")) : undefined);
  const terminal = new FakeTerminal();
  app = new TuiApp({
    connection, guard: new SubmissionGuard(pendingStore, connection), pendingStore, state, terminal,
    initialSessionId: opts.workspace ? undefined : "sess_fake", workspace: opts.workspace, onExit: () => {},
  });
  // 记下 TUI 发起的每个请求；refused 另记断线期间被连接层以未发送拒绝的（必然失败的查询）
  const attempts: TuiOp[] = [];
  const refusals: TuiOp[] = [];
  const request = connection.request.bind(connection);
  connection.request = <K extends TuiOp>(op: K, params: OpParams<K>, timeoutMs?: number) => {
    attempts.push(op);
    return request(op, params, timeoutMs).catch((err: unknown) => {
      if (requestOutcome(err) === "not_sent") refusals.push(op);
      throw err;
    });
  };
  await app.start();
  await waitFor("TUI 上线", () => connection.state === "online");
  const requested = (op: TuiOp) => attempts.filter((a) => a === op).length;
  const refused = (op: TuiOp) => refusals.filter((a) => a === op).length;
  const notes = (text: string) =>
    [...state.globalNotes, ...state.openSession("sess_fake").flow.items.filter((e) => e.kind === "note")].filter((n) => n.text.includes(text)).length;
  const commandResult = () => state.openSession("sess_fake").flow.items.findLast((e) => e.kind === "command")?.result ?? "";
  return {
    app, ctl, state, terminal, pendingStore, requested, refused, notes, commandResult,
    quit: () => {
      app!.quit(0);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function pickFullAccess(h: Awaited<ReturnType<typeof startFakeApp>>): Promise<void> {
  h.terminal.send("/mode\r");
  await waitFor("模式列表", () => h.terminal.output().includes("Full access"));
  h.terminal.send("\x1b[B");
  await new Promise((r) => setTimeout(r, 40));
  h.terminal.send("\r");
}

test("历史单条补读只延后尚未落盘条目，损坏标记的错误必须可见", async () => {
  const h = await startFakeApp({ handlers: { read_history_entry: params => {
    throw new ControlClientError(params.entry_id === "pending" ? "entry_not_found" : "history_corrupt", "宿主标记无法配对", "rejected");
  } } });
  try {
    await h.app.loadEntry("sess_fake", "pending");
    assert.equal(h.notes("历史条目读取失败"), 0);
    await h.app.loadEntry("sess_fake", "corrupt");
    assert.equal(h.notes("历史条目读取失败：宿主标记无法配对"), 1);
  } finally { h.quit(); }
});

function compaction(overrides: Partial<SessionCompactionRequest> = {}): SessionCompactionRequest {
  return {
    requestId: "compact_fake", sessionId: "sess_fake", prompt: null, paramsDigest: "digest", modelSelection: { ...MODEL },
    summaryModel: { provider: "mock", modelId: "summary" }, source: null, expectedCheckpointId: null, status: "running",
    checkpointId: null, summarizedCount: 0, estimateBefore: null, estimateAfter: null, errorCode: null, errorMessage: null,
    createdAt: T0, endedAt: null, ...overrides,
  };
}

test("/compact：快速接收保存关联，切走后完成事件只更新发起会话，统计与 /context 说明保留", async () => {
  let current: SessionCompactionRequest | null = null;
  const h = await startFakeApp({ snapshot: { sessions: [session(), session({ id: "sess_other" })] }, handlers: {
    compact_session: params => current = compaction({ requestId: params.request_id, prompt: params.prompt ?? null }),
    get_session_compaction: params => params.session_id === "sess_fake" ? current : null,
  } });
  try {
    h.terminal.send("/compact 保留  迁移细节\r");
    await waitFor("压缩接收结果", () => h.commandResult().includes("正在压缩"));
    const request = current!;
    assert.equal(request.prompt, "保留  迁移细节");
    const pending = new PendingRequestStore(path.join(h.pendingStore.dir, "compactions"));
    assert.equal(pending.list().records[0]!.requestId, request.requestId);
    (h.app as any).switchSession("sess_other", true);
    current = { ...request, status: "succeeded", checkpointId: "cp_fake", summarizedCount: 12, estimateBefore: 1200, estimateAfter: 800, endedAt: T0 };
    h.ctl.transports[0]!.emit({ seq: 1, createdAt: T0, taskId: null, sessionId: request.sessionId,
      body: { type: "session.context_compaction", sessionId: request.sessionId, requestId: request.requestId, status: "succeeded" } });
    await waitFor("原会话结果更新", () => h.commandResult().includes("摘要覆盖 12 条"));
    assert.match(h.commandResult(), /历史上下文估算 1200 → 800 token；摘要模型 mock\/summary/);
    assert.match(h.commandResult(), /\/context 仍显示最近一次主模型调用/);
    assert.equal(h.state.currentSessionId, "sess_other");
    assert.ok(!h.state.openSession("sess_other").flow.items.some(row => row.kind === "note" && row.text.includes("压缩")));
    assert.equal(pending.list().records.length, 0);
    assert.equal(h.requested("submit"), 0);
    assert.equal(h.requested("compact_session"), 1);
  } finally { h.quit(); }
});

test("/compact：接收应答丢失先核实原请求，已提交不重发；未接收只按原键重试", async () => {
  for (const accepted of [true, false]) {
    let current: SessionCompactionRequest | null = null;
    const keys: string[] = [];
    const h = await startFakeApp({ handlers: {
      compact_session: params => {
        keys.push(params.request_id);
        if (keys.length === 1) {
          if (accepted) current = compaction({ requestId: params.request_id, status: "succeeded", summarizedCount: 5, estimateBefore: 900, estimateAfter: 300, endedAt: T0 });
          throw new ControlClientError("request_timeout", "模拟应答丢失", "unknown");
        }
        return current = compaction({ requestId: params.request_id, status: "noop", endedAt: T0 });
      },
      get_session_compaction: () => current,
    } });
    try {
      h.terminal.send("/compact\r");
      await waitFor("原请求终态核实", () => h.commandResult().includes(accepted ? "上下文已压缩" : "无需压缩"));
      assert.equal(keys.length, accepted ? 1 : 2);
      assert.equal(new Set(keys).size, 1);
      assert.equal(new PendingRequestStore(path.join(h.pendingStore.dir, "compactions")).list().records.length, 0);
      assert.equal((h.app as any).editor.getExpandedText(), "", "不把未知结果恢复成普通草稿");
    } finally { h.quit(); }
  }
});

test("/compact：重连和退出重进按实例、会话与原键核实，不自动换键；另一客户端查询最新状态", async () => {
  const current = compaction({ status: "interrupted", errorCode: "backend_restart", endedAt: T0 });
  const requested: Array<{ sessionId: string; requestId: string | undefined }> = [];
  const h = await startFakeApp({ handlers: {
    get_session_compaction: params => { requested.push({ sessionId: params.session_id, requestId: params.request_id }); return current; },
  } }, { commandHistory: true, seed: store => {
    new CommandHistoryStore(path.join(store.dir, "commands.sqlite")).save("inst-1", current.sessionId,
      { key: "command:before-exit", kind: "command", line: "/compact 保留迁移", result: "正在压缩", isError: false, at: T0, seq: 1 });
    new PendingRequestStore(path.join(store.dir, "compactions")).save({ requestId: current.requestId, op: "compact_session", instanceId: "inst-1",
      params: { session_id: current.sessionId, prompt: "保留迁移", line: "/compact 保留迁移", command_key: "command:before-exit" }, createdAt: T0 });
  } });
  try {
    await waitFor("重进核实终态", () => h.commandResult().includes("手动压缩已中断"));
    assert.equal(h.state.openSession(current.sessionId).flow.items.filter(row => row.kind === "command").length, 1);
    assert.match(new CommandHistoryStore(path.join(h.pendingStore.dir, "commands.sqlite")).load("inst-1", current.sessionId)[0]!.result!, /已中断/);
    assert.ok(requested.some(row => row.sessionId === current.sessionId && row.requestId === current.requestId));
    assert.equal(h.requested("compact_session"), 0);
    assert.equal(new PendingRequestStore(path.join(h.pendingStore.dir, "compactions")).list().records.length, 0);
    h.ctl.transports[0]!.drop();
    await waitFor("客户端重连", () => h.ctl.transports.length > 1 && h.state.connection.state === "online");
    assert.ok(requested.some(row => row.requestId === undefined), "无本地关联时查询会话最新请求");
    assert.equal(h.requested("compact_session"), 0);
  } finally { h.quit(); }

  const foreign = await startFakeApp({ handlers: { get_session_compaction: () => null } }, { seed: store => {
    new PendingRequestStore(path.join(store.dir, "compactions")).save({ requestId: "foreign_compact", op: "compact_session", instanceId: "other-instance",
      params: { session_id: "sess_fake", line: "/compact" }, createdAt: T0 });
  } });
  try {
    await waitFor("原实例核实提示", () => foreign.notes("需在原实例核实") > 0);
    assert.equal(foreign.requested("compact_session"), 0);
    assert.equal(new PendingRequestStore(path.join(foreign.pendingStore.dir, "compactions")).list().records.length, 1);
  } finally { foreign.quit(); }
});

test("/compact：完成事件缺失时查询补齐终态，不永久显示正在压缩", async () => {
  let current: SessionCompactionRequest | null = null;
  const h = await startFakeApp({ handlers: {
    compact_session: params => current = compaction({ requestId: params.request_id }),
    get_session_compaction: () => current,
  } });
  try {
    h.terminal.send("/compact\r");
    await waitFor("压缩在途", () => h.commandResult().includes("正在压缩"));
    current = { ...current!, status: "noop", endedAt: T0 };
    await waitFor("查询补齐终态", () => h.commandResult().includes("无需压缩"));
    assert.equal(h.requested("compact_session"), 1);
    assert.equal(new PendingRequestStore(path.join(h.pendingStore.dir, "compactions")).list().records.length, 0);
  } finally { h.quit(); }
});

test("/compact：另一已在线客户端核实终态，补读原命令并持久保存结果后清除共享关联", async () => {
  let current: SessionCompactionRequest | null = null;
  const h = await startFakeApp({ handlers: { get_session_compaction: () => current } }, { commandHistory: true });
  try {
    const commands = new CommandHistoryStore(path.join(h.pendingStore.dir, "commands.sqlite"));
    const pending = new PendingRequestStore(path.join(h.pendingStore.dir, "compactions"));
    commands.save("inst-1", "sess_fake", { key: "command:other-client", kind: "command", line: "/compact", result: "正在压缩（请求 compact_shared）", isError: false, at: T0, seq: 1 });
    pending.save({ requestId: "compact_shared", op: "compact_session", instanceId: "inst-1",
      params: { session_id: "sess_fake", command_key: "command:other-client", line: "/compact" }, createdAt: T0 });
    current = compaction({ requestId: "compact_shared", status: "succeeded", endedAt: T0 });
    h.ctl.transports[0]!.emit({ seq: 1, createdAt: T0, taskId: null, sessionId: "sess_fake",
      body: { type: "session.context_compaction", sessionId: "sess_fake", requestId: "compact_shared", status: "succeeded" } });
    await waitFor("另一客户端补齐原命令结果", () => h.commandResult().includes("上下文已压缩"));
    assert.equal(pending.list().records.length, 0);
    assert.match(commands.load("inst-1", "sess_fake")[0]!.result!, /上下文已压缩/);
    assert.equal(h.requested("compact_session"), 0);
  } finally { h.quit(); }
});

test("/compact：前次终态后到达的旧 running 接收应答不复活原请求或覆盖新命令", async () => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const requests = new Map<string, SessionCompactionRequest>();
  let first: SessionCompactionRequest | null = null;
  let oldDelivered = false;
  const h = await startFakeApp({ handlers: {
    compact_session: async params => {
      const running = compaction({ requestId: params.request_id });
      requests.set(running.requestId, running);
      if (!first) { first = running; await delayed; oldDelivered = true; return running; }
      const done = { ...running, status: "noop" as const, endedAt: T0 };
      requests.set(done.requestId, done);
      return done;
    },
    get_session_compaction: params => params.request_id ? requests.get(params.request_id) ?? null : null,
  } });
  try {
    h.terminal.send("/compact 第一份\r");
    await waitFor("首请求已接收", () => first !== null);
    const completed = { ...first!, status: "succeeded" as const, endedAt: T0 };
    requests.set(completed.requestId, completed);
    h.ctl.transports[0]!.emit({ seq: 1, createdAt: T0, taskId: null, sessionId: "sess_fake",
      body: { type: "session.context_compaction", sessionId: "sess_fake", requestId: completed.requestId, status: "succeeded" } });
    await waitFor("首请求终态", () => h.commandResult().includes("上下文已压缩"));
    h.terminal.send("/compact 第二份\r");
    await waitFor("第二份完成", () => h.commandResult().includes("无需压缩"));
    release();
    await waitFor("旧应答已到达", () => oldDelivered);
    h.terminal.send("/compact 第三份\r");
    await waitFor("第三份独立提交", () => h.requested("compact_session") === 3);
    assert.ok(!h.state.openSession("sess_fake").flow.items.some(row => row.kind === "note" && row.text.includes("正在压缩")));
  } finally { release(); h.quit(); }
});

test("/compact 与普通输入明确拒绝保留草稿；/interrupt 取消压缩并核实成功竞争", async () => {
  const rejected = await startFakeApp({ handlers: {
    compact_session: () => { throw new ControlClientError("session_busy", "会话有活动任务，请先停止任务", "rejected"); },
    submit: () => { throw new ControlClientError("session_compacting", "会话正在压缩，请先等待或停止", "rejected"); },
  } });
  try {
    rejected.terminal.send("/compact 保留  细节\r");
    await waitFor("拒绝命令草稿", () => (rejected.app as any).editor.getExpandedText() === "/compact 保留  细节");
    assert.match(rejected.commandResult(), /失败：会话有活动任务/);
    assert.equal(new PendingRequestStore(path.join(rejected.pendingStore.dir, "compactions")).list().records.length, 0);
    (rejected.app as any).editor.setText("");
    rejected.terminal.send("稍后再执行\r");
    await waitFor("普通输入草稿", () => (rejected.app as any).editor.getExpandedText() === "稍后再执行");
    assert.equal(rejected.pendingStore.list().records.length, 0);
  } finally { rejected.quit(); }

  for (const status of ["cancelled", "succeeded"] as const) {
    let current: SessionCompactionRequest | null = null;
    const h = await startFakeApp({ handlers: {
      compact_session: params => current = compaction({ requestId: params.request_id }),
      get_session_compaction: () => current,
      interrupt_session_compaction: params => current = compaction({ requestId: params.request_id, status, endedAt: T0 }),
    } });
    try {
      h.terminal.send("/compact\r");
      await waitFor("压缩在途", () => h.commandResult().includes("正在压缩"));
      h.terminal.send("/interrupt\r");
      await waitFor("压缩中断结果", () => h.requested("interrupt_session_compaction") === 1);
      await waitFor("唯一终态", () => h.state.openSession("sess_fake").flow.items.some(row => row.kind === "command" && row.line === "/compact" && row.result?.includes(status === "cancelled" ? "已取消" : "上下文已压缩")));
      assert.equal(h.requested("interrupt"), 0);
      assert.equal(new PendingRequestStore(path.join(h.pendingStore.dir, "compactions")).list().records.length, 0);
    } finally { h.quit(); }
  }
});

test("/mode 断线：结果行提示结果未知，不发必然失败的查询；重连快照带回后台实际值", async () => {
  let dropped = false;
  const h = await startFakeApp({
    snapshot: undefined,
    handlers: {
      set_session_mode: (_params, transport) => {
        dropped = true;
        transport.drop();
        return new Promise(() => {});
      },
      get_session: () => session(),
    },
    handshake: () => ({
      seq: 0,
      replay: [],
      snapshot: fakeSnapshot({ projects: [PROJECT], sessions: [session(dropped ? { defaultAccessMode: "full_access", defaultAccessModeVersion: 2 } : {})] }),
    }),
  });
  try {
    await pickFullAccess(h);
    await waitFor("结果行", () => h.commandResult().includes("连接已断开"));
    assert.match(h.commandResult(), /结果未知.*未自动重发/);
    await waitFor("重连快照", () => h.state.sessions[0]?.defaultAccessMode === "full_access");
    assert.equal(h.refused("get_session"), 0, "断线时不发必然失败的查询");
    assert.equal(h.requested("set_session_mode"), 1, "不自动重发");
  } finally {
    h.quit();
  }
});

test("/mode 应答丢失而连接仍在（超时）：立即查询后台状态", async () => {
  const h = await startFakeApp({
    handlers: {
      set_session_mode: () => Promise.reject(new ControlClientError("request_timeout", "请求超时：set_session_mode", "unknown")),
      get_session: () => session({ defaultAccessMode: "full_access", defaultAccessModeVersion: 2 }),
    },
  });
  try {
    await pickFullAccess(h);
    await waitFor("查询后更新", () => h.state.sessions[0]?.defaultAccessMode === "full_access");
    assert.match(h.commandResult(), /设置应答丢失；正在查询后台状态/);
    assert.equal(h.requested("get_session"), 1);
  } finally {
    h.quit();
  }
});

test("审批断线：页脚提示结果未知，以重连后的审批列表为准，不查询不重放", async () => {
  const h = await startFakeApp(
    approvalScript((_params, transport) => {
      transport.drop();
      return new Promise(() => {});
    }),
  );
  try {
    await openApproval(h);
    await waitFor("页脚", () => h.terminal.output().includes("应答结果未知：连接已断开"));
    await waitFor("重连", () => h.ctl.transports.length === 2);
    assert.equal(h.refused("get_task"), 0, "断线时不发必然失败的查询");
    assert.equal(h.requested("respond_confirmation"), 1, "不自动重放");
  } finally {
    h.quit();
  }
});

test("审批应答丢失而连接仍在：立即查询后台实际状态，不重放", async () => {
  const h = await startFakeApp(
    approvalScript(() => Promise.reject(new ControlClientError("response_too_large", "应答超过帧上限", "unknown")), "approved"),
  );
  try {
    const before = h.requested("get_task");
    await openApproval(h);
    await waitFor("页脚", () => h.terminal.output().includes("后台实际状态：approved"));
    assert.equal(h.requested("get_task"), before + 1, "查询一次");
    assert.equal(h.requested("respond_confirmation"), 1, "不自动重放");
  } finally {
    h.quit();
  }
});

const MOCK_MODEL = { provider: "mock", modelId: "mock-model", name: "Mock Model", contextWindow: 200000, maxTokens: 8192, thinkingLevels: ["off" as const], available: true, errorCode: null };

async function pickCurrentModel(h: Awaited<ReturnType<typeof startFakeApp>>): Promise<void> {
  h.terminal.send("/model\r");
  await waitFor("模型面板", () => h.terminal.output().includes("Mock Model"));
  h.terminal.send("\r");
}

test("/model 断线：结果行提示结果未知，不发必然失败的查询", async () => {
  const h = await startFakeApp({
    handlers: {
      list_models: () => ({ models: [MOCK_MODEL], total: 1, nextOffset: null }),
      set_session_model: (_params, transport) => {
        transport.drop();
        return new Promise(() => {});
      },
    },
  });
  try {
    await pickCurrentModel(h);
    await waitFor("结果行", () => h.commandResult().includes("连接已断开"));
    assert.match(h.commandResult(), /模型设置结果未知.*未自动重发/);
    assert.equal(h.refused("get_session"), 0, "断线时不发必然失败的查询");
  } finally {
    h.quit();
  }
});

test("/model 被其他客户端修改：刷新后台实际值，不覆盖", async () => {
  const h = await startFakeApp({
    handlers: {
      list_models: () => ({ models: [MOCK_MODEL], total: 1, nextOffset: null }),
      set_session_model: () => Promise.reject(new ControlClientError("model_selection_conflict", "模型选择已被修改", "rejected")),
      get_session: () => session({ modelSelection: { ...MODEL, thinkingLevel: "high" }, modelSelectionVersion: 2 }),
    },
  });
  try {
    await pickCurrentModel(h);
    await waitFor("刷新", () => h.state.sessions[0]?.modelSelectionVersion === 2);
    assert.match(h.commandResult(), /模型已被其他客户端修改/);
    assert.equal(h.requested("set_session_model"), 1, "不重发");
  } finally {
    h.quit();
  }
});

test("工作区入口遇到坏帧：等重连快照按启动请求标识核实，不重发", async () => {
  let createRequestId: string | null = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-fake-"));
  const created = () => session({ id: "sess_ws", cwd: dir, cwdReal: fs.realpathSync(dir), createRequestId });
  const h = await startFakeApp(
    {
      handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ projects: [PROJECT], sessions: createRequestId ? [created()] : [] }) }),
      handlers: {
        open_workspace: (params, transport) => {
          createRequestId = params.request_id ?? null;
          transport.drop("bad_frame", "收到非法 JSON 帧");
          return new Promise(() => {});
        },
      },
    },
    { workspace: { path: dir } },
  );
  try {
    await waitFor("重连后进入已建会话", () => h.state.currentSessionId === "sess_ws");
    assert.equal(h.requested("open_workspace"), 1, "按启动请求标识在快照里找到，不重发");
  } finally {
    h.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("提交应答丢失而连接仍在：当场按原键核实这一条并关联原任务，记录清除", async () => {
  const accepted = task({ id: "task_accepted" });
  const h = await startFakeApp(
    {
      handlers: {
        submit: () => Promise.reject(new ControlClientError("request_timeout", "请求超时：submit", "unknown")),
        find_task: () => ({ task: accepted }),
      },
    },
    {
      // 另一条属于其他数据实例的旧记录：上线时报一次，当场核实不再碰它
      seed: (store) => store.save({ requestId: "req_foreign", op: "submit", params: {}, instanceId: "inst-other", createdAt: T0 }),
    },
  );
  try {
    await waitFor("上线核实", () => h.notes("属于其他数据实例") === 1);
    h.terminal.send("帮我看看\r");
    await waitFor("关联原任务", () => h.notes("已由后台接收：关联原任务 task_accepted") === 1);
    assert.deepEqual(h.pendingStore.list().records.map((r) => r.requestId), ["req_foreign"], "只清除这一条");
    assert.equal(h.notes("属于其他数据实例"), 1, "当场核实只核实这一条");
    assert.equal(h.requested("submit"), 1, "查到已接收，不重发");
  } finally {
    h.quit();
  }
});

test("工作区入口两次应答丢失：只当场核实一次，然后回落正常启动", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-fake-"));
  const h = await startFakeApp(
    { handlers: { open_workspace: () => Promise.reject(new ControlClientError("internal_error", "内部错误", "unknown")) } },
    { workspace: { path: dir } },
  );
  try {
    await waitFor("回落正常启动", () => h.notes("已核实一次仍未确认") === 1);
    assert.equal(h.requested("open_workspace"), 2, "当场核实只重发一次");
  } finally {
    h.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("工作区入口的本地前置检查（项目不在快照里）：按明确拒绝回落，不说成应答丢失", async () => {
  const client = { request: () => assert.fail("不应发出请求") };
  const identity = { cwd: "/x", cwdReal: "/x", dev: 0, ino: 0 };
  const err = await ensureWorkspaceSession(client, { projects: [], sessions: [] }, identity, { projectId: "proj_gone", startupRequestId: "boot-x" }).then(
    () => assert.fail("应当失败"),
    (e: unknown) => e,
  );
  assert.equal(requestOutcome(err), "rejected");
});

test("CLI submit：后台明确拒绝时打印「提交被拒绝」，不再提示按原键核实", async () => {
  const t = await startTestRuntime("cli-reject", routeResponder([]));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // CLI 按 <控制目录>/control.sock 连接；测试后台用短 socket 路径，链过去
    const controlDir = t.runtime.controlDir();
    fs.symlinkSync(t.runtime.socketPath(), path.join(controlDir, "control.sock"));
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const child = childProcess.spawn(
      path.join(repoRoot, "node_modules", ".bin", "tsx"),
      ["apps/ruukoto-code/src/main.ts", "submit", sessionId, "req-cli-reject", "你好", "--model", "mock/no-such-model", "--thinking", "off"],
      { cwd: repoRoot, env: { ...process.env, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CODE_CONTROL_DIR: controlDir, RUUKOTO_CODE_PENDING_DIR: path.join(t.dirs.root, "pending"), RUUKOTO_OWNER_TOKEN: "", RUUKOTO_OWNER_TOKEN_FILE: "" } },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.notEqual(status, 0);
    assert.match(stderr, /提交被拒绝：模型不在后台已配置的目录中/);
    assert.doesNotMatch(stderr, /勿换键重试/);
  } finally {
    await t.shutdown();
  }
});
