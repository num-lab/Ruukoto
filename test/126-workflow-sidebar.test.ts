import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { WorkflowSidebar } from "@ruukoto/tui/tui/workflows.ts";
import { FakeTransport, type FakeHandlers } from "./helpers/fake-control.ts";

type WriteOp = "workflow_start" | "workflow_answer" | "workflow_control";
const WRITE_OPS: TuiOp[] = ["workflow_start", "workflow_answer", "workflow_control"];
const ENTER = "\r", ESC = "\x1b", DOWN = "\x1b[B";

function detail(): OpResult<"workflow_get"> {
  return {
    run: { id: "run-original", sessionId: "session-original", displayName: "批处理", description: "原业务说明", createdAt: "2026-10-14T00:00:00.000Z",
      definitionId: "definition-original", scriptDigest: "script-digest", inputDigest: "input-digest", status: "waiting", version: 4,
      reason: null, attempts: 0, maxAttempts: 100, usedMs: 0, durationMs: 3600000, clockVerified: true, scriptStopVerified: true,
      effectUnknown: false, stopUnverified: false, number: 1, terminalVersion: undefined, delivery: undefined },
    steps: [{ key: "pick", kind: "ask", status: "waiting", resultRecorded: false, attempts: 0, question: "pending", outputArtifact: null }],
    stepOffset: 0, totalSteps: 1, nextStepOffset: null, executions: [],
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function harness(opts: { pending?: PendingRequestStore; instance?: string; hold?: Promise<void>; lose?: boolean; received?: boolean; failQueries?: boolean; handlers?: FakeHandlers } = {}) {
  const pending = opts.pending ?? new PendingRequestStore(fs.mkdtempSync(path.join(os.tmpdir(), "workflow-sidebar-")));
  const state = { detail: detail(), instance: opts.instance ?? "instance-original", received: opts.received ?? false, questionVersion: 2, session: "session-original" as string | null };
  const lost = async () => {
    await opts.hold;
    if (opts.lose) throw new ControlClientError("request_timeout", "应答丢失", "unknown");
  };
  const transport = new FakeTransport({ handlers: {
    workflow_list: params => ({ runs: [state.detail.run], total: 1, offset: params.offset ?? 0, nextOffset: null }),
    workflow_get: () => state.detail,
    workflow_definitions: () => ({ definitions: [{ name: "batch" }], total: 1, offset: 0, nextOffset: null }),
    workflow_question: () => ({ runId: state.detail.run.id, stepKey: "pick", status: "pending", version: state.questionVersion, runVersion: 4,
      text: "请选择下一步", offset: 0, totalBytes: Buffer.byteLength("请选择下一步"), truncated: false, choices: ["yes", "no"] }),
    workflow_start: async () => { await lost(); return state.detail; },
    workflow_answer: async () => { await lost(); return { runId: state.detail.run.id, stepKey: "pick", status: "answered", version: state.questionVersion + 1, runVersion: 4 }; },
    workflow_control: async () => { await lost(); return state.detail; },
    workflow_find: () => {
      if (opts.failQueries) throw new ControlClientError("connection_unavailable", "查询暂不可用", "not_sent");
      return state.received ? state.detail : null;
    },
    workflow_receipt: params => {
      if (opts.failQueries) throw new ControlClientError("connection_unavailable", "查询暂不可用", "not_sent");
      if (!state.received) return null;
      return params.operation === "workflow_answer"
        ? { operation: "workflow_answer", runId: params.run_id, stepKey: "pick", status: "answered", version: 3, runVersion: 4 }
        : { operation: "workflow_control", runId: params.run_id, status: "paused", version: 5 };
    },
    ...opts.handlers,
  } });
  const request: ControlConnection["request"] = (op, params) => {
    if (WRITE_OPS.includes(op)) {
      const records = pending.list().records;
      assert.equal(records.length, 1, "调用发送入口时原请求已持久保存");
      const record = records[0];
      assert.equal(record.op, op);
      assert.deepEqual(record.params, params);
      assert.equal(record.instanceId, state.instance);
      assert.equal(fs.statSync(path.join(pending.dir, `${record.requestId}.json`)).mode & 0o777, 0o600);
    }
    return transport.request(op, params);
  };
  let closed = 0;
  const sidebar = new WorkflowSidebar({ request, pending, sessionId: () => state.session, instanceId: () => state.instance,
    online: () => true, rows: () => 40, render: () => {}, close: () => { closed++; }, approvals: () => {} });
  sidebar.focused = true;
  const draw = () => stripVTControlCharacters(sidebar.render(100).join("\n"));
  const press = async (key: string) => { sidebar.handleInput(key); await settle(); };
  const pick = async (label: string) => {
    for (let i = 0; i < 30; i++) {
      if (draw().split("\n").some(line => line.includes("│ → ") && line.includes(label))) { await press(ENTER); return; }
      await press(DOWN);
    }
    assert.fail(`找不到可选项 ${label}：\n${draw()}`);
  };
  const prepare = async (op: WriteOp) => {
    sidebar.open(); await settle();
    if (op === "workflow_start") {
      await pick("启动工作流"); await pick("batch");
      await press(ENTER);
      await press("本次批次"); await press(ENTER);
      assert.match(draw(), /确认启动/);
    } else {
      await pick("批处理");
      if (op === "workflow_answer") { await pick("回答问题"); await pick("yes"); assert.match(draw(), /确认回答/); }
      else { await pick("暂停"); assert.match(draw(), /确认暂停/); }
    }
  };
  return { sidebar, pending, state, transport, draw, press, pick, prepare, closed: () => closed,
    writes: () => transport.requests.filter(request => WRITE_OPS.includes(request.op)),
    cleanup: () => fs.rmSync(pending.dir, { recursive: true, force: true }) };
}

for (const op of WRITE_OPS as WriteOp[]) {
  test(`工作流侧栏 ${op}：真实键盘逐层确认，先持久保存，重复 Enter 仅发送一次`, async () => {
    const gate = deferred(), h = harness({ hold: gate.promise });
    try {
      await h.prepare(op);
      h.sidebar.handleInput(ENTER); h.sidebar.handleInput(ENTER);
      await settle();
      assert.equal(h.writes().length, 1);
      assert.equal(h.pending.list().records.length, 1);
      assert.match(h.draw(), /核实原提交/);
      gate.release(); await settle();
      assert.equal(h.pending.list().records.length, 0);
      assert.match(h.draw(), /后台已接收/);
    } finally { gate.release(); h.cleanup(); }
  });

  test(`工作流侧栏 ${op}：存储失败时保留确认界面且零发送`, async () => {
    const h = harness();
    try {
      await h.prepare(op);
      fs.rmSync(h.pending.dir, { recursive: true });
      fs.writeFileSync(h.pending.dir, "阻断目录写入");
      await h.press(ENTER);
      assert.equal(h.writes().length, 0);
      assert.match(h.draw(), /保存失败，操作未发送/);
    } finally { h.cleanup(); }
  });

  test(`工作流侧栏 ${op}：应答丢失只查询原提交，不重复业务动作`, async () => {
    const h = harness({ lose: true, received: true });
    try {
      await h.prepare(op); await h.press(ENTER);
      assert.equal(h.writes().length, 1);
      assert.equal(h.pending.list().records.length, 0);
      const queries = h.transport.requests.filter(request => request.op === "workflow_find" || request.op === "workflow_receipt");
      assert.equal(queries.length, 1);
      assert.equal(queries[0].op, op === "workflow_start" ? "workflow_find" : "workflow_receipt");
      assert.match(h.draw(), /后台已接收，未重复发送/);
      await h.press(ENTER);
      assert.equal(h.writes().length, 1, "核实已接收后原确认界面不可再次生成业务请求");
    } finally { h.cleanup(); }
  });
}

for (const op of WRITE_OPS as WriteOp[]) test(`工作流侧栏 ${op}：客户端重建从原 store 只读恢复`, async () => {
  const first = harness({ lose: true, failQueries: true });
  try {
    await first.prepare(op); await first.press(ENTER);
    assert.equal(first.pending.list().records.length, 1);
    const original = first.pending.list().records[0];
    const next = harness({ pending: new PendingRequestStore(first.pending.dir), received: true });
    next.sidebar.open(); await next.sidebar.reconnect(); await settle();
    assert.equal(next.writes().length, 0);
    assert.equal(next.pending.list().records.length, 0);
    const query = next.transport.requests.find(request => request.op === "workflow_find" || request.op === "workflow_receipt");
    assert.ok(query);
    assert.deepEqual(query.params, op === "workflow_start"
      ? { session_id: original.params.session_id, request_id: original.requestId }
      : { run_id: original.params.run_id, request_id: original.requestId, operation: op });
  } finally { first.cleanup(); }
});

test("工作流侧栏：实例变化零重发，损坏记录留盘并可通过选择查看", async () => {
  const first = harness({ lose: true, failQueries: true });
  try {
    await first.prepare("workflow_control"); await first.press(ENTER);
    const original = first.pending.list().records[0];
    const broken = path.join(first.pending.dir, "broken.json");
    fs.writeFileSync(broken, "{损坏原文");
    const next = harness({ pending: first.pending, instance: "new-database", received: true });
    next.sidebar.open(); await next.sidebar.reconnect(); await settle();
    assert.equal(next.writes().length, 0);
    assert.equal(next.transport.requests.some(request => request.op === "workflow_find" || request.op === "workflow_receipt"), false);
    assert.deepEqual(next.pending.list().records, [original]);
    await next.pick("待核实操作");
    assert.match(next.draw(), /broken\.json/);
    await next.press(ENTER);
    assert.match(next.draw(), /属于其他数据实例/);
    await next.press(ENTER);
    assert.equal(next.writes().length, 0);
    assert.equal(fs.readFileSync(broken, "utf8"), "{损坏原文");
  } finally { first.cleanup(); }
});

test("工作流侧栏：原键查询明确未接收后，键盘确认才按原键原参数重试", async () => {
  const h = harness({ lose: true });
  try {
    await h.prepare("workflow_start"); await h.press(ENTER);
    const original = h.pending.list().records[0];
    assert.equal(h.writes().length, 1);
    await h.press(ESC); await h.press(ESC); await h.press(ESC); await h.press(ESC);
    await h.pick("待核实操作"); await h.press(ENTER);
    await h.pick("按原请求重试");
    assert.equal(h.writes().length, 1, "选择重试仍须确认");
    await h.press(ENTER);
    assert.equal(h.writes().length, 2);
    assert.deepEqual(h.writes()[1].params, original.params);
    assert.deepEqual(h.pending.list().records, [original]);
  } finally { h.cleanup(); }
});

test("工作流侧栏：过期控制拒绝后返回详情，重新确认使用最新版本与新请求键", async () => {
  const controls: OpParams<"workflow_control">[] = [];
  const h = harness({ handlers: { workflow_control: params => {
    controls.push(params);
    if (controls.length === 1) {
      h.state.detail.run.version++;
      throw new ControlClientError("version_conflict", "运行状态已变化", "rejected");
    }
    return h.state.detail;
  } } });
  try {
    await h.prepare("workflow_control"); await h.press(ENTER);
    assert.match(h.draw(), /后台明确拒绝/);
    assert.equal(h.pending.list().records.length, 0);
    assert.match(h.draw(), /运行详情/);
    await h.press(ENTER);
    assert.equal(controls.length, 1, "旧确认已退出，Enter 不能沿用过期版本重发");
    await h.press(ESC); await h.pick("暂停"); await h.press(ENTER);
    assert.deepEqual(controls.map(params => params.expected_version), [4, 5]);
    assert.notEqual(controls[0].request_id, controls[1].request_id);
    assert.equal(h.pending.list().records.length, 0);
  } finally { h.cleanup(); }
});

test("工作流侧栏：人工问题过期后重新选择问题，核实最新问题版本再回答", async () => {
  const answers: OpParams<"workflow_answer">[] = [];
  const h = harness({ handlers: { workflow_answer: params => {
    answers.push(params);
    if (answers.length === 1) {
      h.state.questionVersion++;
      throw new ControlClientError("stale_answer", "原问题已变化", "rejected");
    }
    return { runId: params.run_id, stepKey: params.step_key, status: "answered", version: params.question_version + 1, runVersion: params.run_version };
  } } });
  try {
    await h.prepare("workflow_answer"); await h.press(ENTER);
    assert.match(h.draw(), /后台明确拒绝/);
    assert.equal(h.pending.list().records.length, 0);
    assert.match(h.draw(), /运行详情/);
    await h.press(ENTER);
    assert.equal(answers.length, 1, "旧回答确认已退出，Enter 不会重发过期答案");
    await h.press(ESC);
    await h.pick("回答问题"); await h.pick("yes"); await h.press(ENTER);
    assert.deepEqual(answers.map(params => params.question_version), [2, 3]);
    assert.notEqual(answers[0].request_id, answers[1].request_id);
    assert.equal(h.pending.list().records.length, 0);
  } finally { h.cleanup(); }
});

test("工作流侧栏：损坏的启动标题不能恢复，原记录仍可从待核实操作查看", async () => {
  const h = harness();
  try {
    const starts: Array<{ requestId: string; params: OpParams<"workflow_start"> }> = [
      { requestId: "missing_title", params: { session_id: "session-original", request_id: "missing_title", script: "return 1;", input: null } },
      { requestId: "invalid_title", params: { session_id: "session-original", request_id: "invalid_title", script: "return 1;", title: "损坏\n标题", input: null } },
      { requestId: "extra_title", params: { session_id: "session-original", request_id: "extra_title", name: "batch", title: "意外标题", input: null } },
    ];
    for (const start of starts) h.pending.save({ ...start, op: "workflow_start", instanceId: h.state.instance, createdAt: "2026-10-14T00:00:00.000Z" });
    const originals = starts.map(start => fs.readFileSync(path.join(h.pending.dir, `${start.requestId}.json`), "utf8"));
    h.sidebar.open(); await h.sidebar.reconnect(); await settle();
    assert.equal(h.writes().length, 0);
    assert.equal(h.transport.requests.some(request => request.op === "workflow_find"), false);
    assert.deepEqual(h.pending.list().records, []);
    assert.deepEqual(h.pending.list().corrupt.sort(), starts.map(start => `${start.requestId}.json`).sort());
    await h.pick("待核实操作");
    assert.match(h.draw(), /invalid_title\.json/);
    assert.deepEqual(starts.map(start => fs.readFileSync(path.join(h.pending.dir, `${start.requestId}.json`), "utf8")), originals);
  } finally { h.cleanup(); }
});

test("工作流侧栏：Esc 逐层返回，根层关闭不会取消后台运行", async () => {
  const h = harness();
  try {
    h.sidebar.open(); await settle(); await h.pick("批处理");
    assert.match(h.draw(), /运行详情/);
    await h.press(ESC);
    assert.match(h.draw(), /当前会话/);
    assert.equal(h.sidebar.opened, true);
    assert.equal(h.closed(), 0);
    await h.press(ESC);
    assert.equal(h.sidebar.opened, false);
    assert.equal(h.closed(), 1);
    assert.equal(h.writes().length, 0);
  } finally { h.cleanup(); }
});

test("工作流侧栏：长列表续读，事实刷新后按运行身份保留选择，同名以时间和说明区分", async () => {
  let reverse = false;
  const h = harness({ handlers: { workflow_list: params => {
    const runs = Array.from({ length: 41 }, (_, index) => ({ ...h.state.detail.run, id: `run-${index}`, displayName: "同名批处理",
      createdAt: new Date(Date.UTC(2026, 9, 14, 0, index)).toISOString(), description: `批次说明 ${index}` }));
    const offset = params.offset ?? 0;
    const page = runs.slice(offset, offset + 20);
    if (reverse) page.reverse();
    return { runs: page, total: runs.length, offset, nextOffset: offset + 20 < runs.length ? offset + 20 : null };
  } } });
  try {
    h.sidebar.open(); await settle(); await h.press(DOWN);
    assert.match(h.draw(), /00:01:00\.000 UTC · 批次说明 1/);
    reverse = true; h.sidebar.refresh(); await settle(); await h.press(ENTER);
    assert.equal((h.transport.requests.find(request => request.op === "workflow_get")?.params as OpParams<"workflow_get">).run_id, "run-1", "排序变化不能使原选中身份漂移");
    await h.press(ESC); await h.pick("下一页运行");
    assert.match(h.draw(), /当前 21–40/);
    await h.pick("下一页运行"); assert.match(h.draw(), /当前 41–41/);
    await h.pick("上一页运行"); assert.match(h.draw(), /当前 21–40/);
    await h.pick("历史");
    assert.equal((h.transport.requests.filter(request => request.op === "workflow_list").at(-1)?.params as OpParams<"workflow_list">).scope, "history");
  } finally { h.cleanup(); }
});

test("工作流侧栏：长日志正文滚动与按字节续页，业务输入 q 保留原文，查询失败可重新读取", async () => {
  let failed = false;
  const h = harness({ handlers: {
    workflow_logs: params => ({ runId: params.run_id, text: params.offset ? "日志续页终点" : Array.from({ length: 100 }, (_, index) => `中文阶段 ${index}`).join("\n"),
      offset: params.offset ?? 0, totalBytes: 10000, truncated: true }),
    workflow_question: params => {
      if (!failed) { failed = true; throw new ControlClientError("request_timeout", "暂时不可用", "unknown"); }
      return { runId: params.run_id, stepKey: params.step_key, status: "pending", version: 2, runVersion: 4, text: "填写业务名称", offset: 0, totalBytes: 18, truncated: false };
    },
  } });
  try {
    h.sidebar.open(); await settle(); await h.pick("批处理"); await h.pick("阶段日志");
    assert.match(h.draw(), /中文阶段 0/); await h.press("\x1b[6~");
    assert.doesNotMatch(h.draw(), /中文阶段 0/);
    await h.pick("续读下一页");
    assert.match(h.draw(), /日志续页终点/);
    const logs = h.transport.requests.filter(request => request.op === "workflow_logs");
    const first = Array.from({ length: 100 }, (_, index) => `中文阶段 ${index}`).join("\n");
    assert.equal((logs[1].params as OpParams<"workflow_logs">).offset, Buffer.byteLength(first));
    await h.press(ESC); await h.press(ESC);
    await h.pick("回答问题"); assert.match(h.draw(), /查询失败/);
    await h.press("r"); await h.pick("填写回答"); await h.press("question q"); await h.press(ENTER);
    assert.match(h.draw(), /确认回答/); await h.press(ENTER);
    assert.equal((h.writes().at(-1)?.params as OpParams<"workflow_answer">).answer, "question q");
  } finally { h.cleanup(); }
});

test("工作流侧栏：新实例无会话时仍可选择原实例待核实操作", async () => {
  const h = harness();
  try {
    h.pending.save({ requestId: "old_request", op: "workflow_start", params: { session_id: "old-session", request_id: "old_request", name: "batch", input: null },
      instanceId: "old-instance", createdAt: "2026-10-14T00:00:00.000Z" });
    h.state.session = null;
    h.sidebar.open(); await h.sidebar.reconnect(); await settle();
    await h.pick("待核实操作"); await h.press(ENTER);
    assert.match(h.draw(), /属于其他数据实例/);
    assert.equal(h.writes().length, 0);
    assert.equal(h.transport.requests.length, 0);
    assert.equal(h.pending.list().records.length, 1);
  } finally { h.cleanup(); }
});

for (const outcome of ["success", "rejected", "unknown"] as const) test(`工作流侧栏：迟到 ${outcome} 响应不覆盖另一会话的导航与业务草稿`, async () => {
  const gate = deferred();
  const h = harness({ hold: gate.promise, lose: outcome === "unknown", received: true, handlers: outcome === "rejected" ? {
    workflow_control: async () => { await gate.promise; throw new ControlClientError("version_conflict", "运行已变化", "rejected"); },
  } : undefined });
  try {
    await h.prepare("workflow_control"); h.sidebar.handleInput(ENTER); await settle();
    h.state.session = "session-new"; h.sidebar.sessionChanged(); await settle();
    await h.pick("启动工作流"); await h.pick("batch"); await h.press("\x15"); await h.press('{"draft":"保留"}');
    gate.release(); await settle();
    assert.match(h.draw(), /业务参数/); assert.match(h.draw(), /draft.*保留/);
    assert.doesNotMatch(h.draw(), /后台明确拒绝|后台已接收/);
    assert.equal(h.pending.list().records.length, 0);
    assert.equal(h.writes().length, 1);
  } finally { gate.release(); h.cleanup(); }
});

test("工作流侧栏：选中项移到下一页时保留原身份，同毫秒同名由展示序号区分", async () => {
  let inserted = false;
  const originals = Array.from({ length: 20 }, (_, index) => ({ ...detail().run, id: `stable-${index}`, number: index + 1, displayName: "完全同名" }));
  const h = harness({ handlers: {
    workflow_list: () => ({ runs: inserted ? [{ ...originals[0], id: "new", number: 21 }, ...originals.slice(0, 19)] : originals, total: inserted ? 21 : 20, offset: 0, nextOffset: inserted ? 20 : null }),
    workflow_get: params => ({ ...detail(), run: originals.find(run => run.id === params.run_id) ?? detail().run }),
  } });
  try {
    h.sidebar.open(); await settle();
    for (let index = 0; index < 19; index++) await h.press(DOWN);
    assert.match(h.draw(), /第 20 项/);
    inserted = true; h.sidebar.refresh(); await settle();
    assert.match(h.draw(), /移出当前页，保留选择/);
    await h.press(ENTER);
    const reads = h.transport.requests.filter(request => request.op === "workflow_get");
    assert.equal((reads.at(-1)?.params as OpParams<"workflow_get">).run_id, "stable-19");
    assert.match(h.draw(), /完全同名/);
  } finally { h.cleanup(); }
});

test("工作流侧栏：八种运行状态有图标和中文，取消后停止待核实与效果未知单独呈现", async () => {
  const states = [["queued", "○ 排队"], ["running", "▶ 运行中"], ["waiting", "? 待回答/审批"], ["paused", "Ⅱ 已暂停"],
    ["succeeded", "✓ 成功"], ["partial", "! 部分失败"], ["failed", "× 失败"], ["canceled", "■ 已取消"]] as const;
  for (const [status, text] of states) {
    const h = harness();
    try {
      h.state.detail.run.status = status; h.sidebar.open(); await settle(); assert.ok(h.draw().includes(text));
      if (status === "canceled") {
        h.state.detail.run.stopUnverified = true; h.state.detail.run.effectUnknown = true;
        await h.pick("批处理");
        assert.match(h.draw(), /■ 已取消/); assert.match(h.draw(), /停止待核实/); assert.match(h.draw(), /效果未知/);
      }
    } finally { h.cleanup(); }
  }
});

test("工作流侧栏：停止摘要覆盖未返回的旧执行和冷崩溃，恢复必须逐层核实", async () => {
  const h = harness();
  try {
    h.state.detail.run.status = "paused"; h.state.detail.run.stopUnverified = true; h.state.detail.run.scriptStopVerified = null;
    h.sidebar.open(); await settle(); await h.pick("批处理");
    assert.match(h.draw(), /停止待核实/); await h.pick("恢复");
    assert.match(h.draw(), /已核实所有执行停止/);
    await h.press(ENTER); assert.match(h.draw(), /确认恢复/); await h.press(ENTER);
    assert.deepEqual((h.writes()[0].params as OpParams<"workflow_control">).control, { action: "resume", clockConfirmed: true, stopsConfirmed: true });
  } finally { h.cleanup(); }
});

test("工作流侧栏：关闭后重开查询最新事实，保持原选中运行", async () => {
  const h = harness();
  try {
    h.sidebar.open(); await settle(); await h.press(ESC);
    h.state.detail.run.status = "succeeded";
    h.sidebar.open(); await settle();
    assert.match(h.draw(), /✓ 成功/);
    assert.equal(h.transport.requests.filter(request => request.op === "workflow_list").length, 2);
  } finally { h.cleanup(); }
});

test("工作流侧栏：问题约束在输入层验证，错误回答保留并且不发送", async () => {
  const h = harness({ handlers: { workflow_question: params => ({ runId: params.run_id, stepKey: params.step_key, status: "pending", version: 2, runVersion: 4,
    text: "填写正数", offset: 0, totalBytes: 12, truncated: false, schema: { type: "number", minimum: 1 } }) } });
  try {
    h.sidebar.open(); await settle(); await h.pick("批处理"); await h.pick("回答问题"); await h.pick("填写回答");
    await h.press("-1"); await h.press(ENTER);
    assert.match(h.draw(), /当前输入中修正/); assert.match(h.draw(), /> -1/);
    assert.equal(h.writes().length, 0); assert.equal(h.pending.list().records.length, 0);
    await h.press("\x15"); await h.press("2"); await h.press(ENTER);
    assert.match(h.draw(), /确认回答/); await h.press(ENTER);
    assert.equal((h.writes()[0].params as OpParams<"workflow_answer">).answer, 2);
  } finally { h.cleanup(); }
});

test("工作流侧栏：问题选择仍验证约束，冲突选项停留在当前层", async () => {
  const h = harness({ handlers: { workflow_question: params => ({ runId: params.run_id, stepKey: params.step_key, status: "pending", version: 2, runVersion: 4,
    text: "选择回答", offset: 0, totalBytes: 12, truncated: false, choices: ["yes", "no"], schema: { type: "string", const: "yes" } }) } });
  try {
    h.sidebar.open(); await settle(); await h.pick("批处理"); await h.pick("回答问题"); await h.pick("no");
    assert.match(h.draw(), /回答不满足问题约束/); assert.doesNotMatch(h.draw(), /确认回答/);
    assert.equal(h.writes().length, 0); assert.equal(h.pending.list().records.length, 0);
    await h.pick("yes"); assert.match(h.draw(), /确认回答/); await h.press(ENTER);
    assert.equal((h.writes()[0].params as OpParams<"workflow_answer">).answer, "yes");
  } finally { h.cleanup(); }
});
