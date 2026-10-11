/**
 * 合成调试会话（`ruukoto --demo`）：假客户端本身的自检。
 *
 * 目的：这份数据是给界面调试用的，一旦落后于事件类型定义就失去意义。
 * 这里断言它覆盖 PersistentEventBody 的全部 type、seq 连续、且不产生
 * 真实副作用（未列出的 op 明确拒绝）。op 名与返回形状由 op 表的类型检查对照服务端。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { ControlClientError, type ControlTransport } from "@ruukoto/control/client.ts";
import type { PersistentEvent, Task } from "@ruukoto/core/types.ts";
import type { HistoryEntryView, HistoryPage } from "@ruukoto/core/history.ts";
import type { ToolOpView } from "@ruukoto/core/views.ts";
import * as os from "node:os";
import * as path from "node:path";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { TuiApp } from "@ruukoto/tui/tui/app.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { createDemoClient } from "@ruukoto/tui/tui/demo-session.ts";
import { EventFlow } from "@ruukoto/tui/tui/event-flow.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import { waitFor } from "./helpers/testkit.ts";

/** 从类型定义抽出全部事件 type 字面量（新增事件类型时必须同步 demo 数据）。 */
function declaredEventTypes(): string[] {
  const src = fs.readFileSync(new URL("../packages/core/src/types.ts", import.meta.url), "utf8");
  const start = src.indexOf("export type PersistentEventBody");
  const end = src.indexOf("export interface PersistentEvent");
  assert.ok(start >= 0 && end > start, "未能定位 PersistentEventBody 定义");
  return [...src.slice(start, end).matchAll(/\{\s*type:\s*"([a-z_.]+)"/g)].map((m) => m[1]!);
}

/** 收集 demo 客户端推送的全部事件（等事件流自然结束）。 */
async function collect(client: ControlTransport): Promise<PersistentEvent[]> {
  const seen: PersistentEvent[] = [];
  client.onEvent((event) => seen.push(event));
  await client.handshake();
  // 事件按固定间隔推送；连续静默一段时间即认为推送完毕
  let lastCount = -1;
  let quietSince = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    if (seen.length !== lastCount) {
      lastCount = seen.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince > 300) {
      break;
    }
  }
  return seen;
}

test("合成会话覆盖全部事件类型且 seq 连续", async () => {
  const declared = declaredEventTypes();
  const client = createDemoClient(() => {}, 1);
  try {
    const events = await collect(client);
    const pushed = new Set<string>(events.map((e) => e.body.type));
    const missing = declared.filter((t) => !pushed.has(t));
    assert.deepEqual(missing, [], `demo 未覆盖的事件类型：${missing.join(", ")}`);
    assert.equal(pushed.size, declared.length, "demo 推送了类型定义之外的事件");
    // seq 必须连续：TUI 按 seq 检测缺口并触发重新同步
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: events.length }, (_, i) => i + 1),
      "seq 不连续",
    );
  } finally {
    client.close();
  }
});

test("合成会话不产生真实副作用：未列出的 op（写操作）明确拒绝", async () => {
  const client = createDemoClient(() => {});
  try {
    await client.handshake();
    // 读操作有静态应答
    const page = await client.request("read_history", { session_id: "sess_demo0000000000000000" });
    assert.ok(page.entries.length > 0, "历史应为非空");
    const models = await client.request("list_models", {});
    assert.ok(models.models.length > 0, "模型列表应为非空");
    // 写操作必须明确失败，不得静默成功；明确拒绝让提交清掉待核实记录、恢复草稿
    for (const op of ["submit", "create_project", "create_session", "respond_confirmation", "interrupt"] as const) {
      await assert.rejects(
        () => client.request(op, {} as never),
        (err: unknown) => err instanceof ControlClientError && err.outcome === "rejected" && err.message === `合成会话不支持：${op}`,
        `${op} 应被拒绝`,
      );
    }
    // 主动关闭与真实客户端一样通知断线监听者（连接层靠它走重连路径）
    let closedWith: string | null = null;
    client.onClose((info) => (closedWith = info.code));
    client.close();
    assert.equal(closedWith, "closed");
  } finally {
    client.close();
  }
});

test("合成会话支持新 TUI 的任务与事件分页恢复，并提供完整正文、思考阶段和真实 Edit 统计", async () => {
  const client = createDemoClient(() => {}, 60_000);
  try {
    const { snapshot } = await client.handshake();
    const tasks: Task[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await client.request("list_tasks", { session_id: snapshot.sessions[0]!.id, before, limit: 2 });
      tasks.push(...page.tasks);
      if (!page.hasMore) break;
      before = page.tasks.at(-1)!.id;
    }
    assert.equal(new Set(tasks.map((task) => task.id)).size, snapshot.tasks.length);
    assert.ok(tasks.every((task) => task.planMode === false), "合成任务明确携带计划工作方式");
    const completed = tasks.find((task) => task.status === "completed")!;
    const detail = await client.request("get_task", { task_id: completed.id });
    const authorized = detail.toolOps.find(op => op.id === "toolop_demo000001")!;
    assert.deepEqual(authorized.authorization, { source: "full_access", taskId: completed.id, permissionVersion: completed.permissionVersion, scope: { kind: "tool", workspaceOnly: false } });
    assert.ok(Number.isSafeInteger(detail.seq) && detail.seq > 0);
    const flow = new EventFlow();
    flow.task(detail.task);
    detail.toolOps.forEach((op) => flow.tool(op, detail.seq));
    const history = await client.request("read_history", { session_id: completed.sessionId });
    flow.installHistory(history.entries, true, 300);
    const events: PersistentEvent[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await client.request("read_task_events", { task_id: completed.id, after_seq: after, limit: 3 });
      assert.ok(page.events.every((event) => event.taskId === completed.id && event.seq > after));
      page.events.forEach((event) => flow.apply(event));
      events.push(...page.events);
      pages++;
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    assert.ok(pages > 1);
    assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
    assert.ok(events.some((event) => event.body.type === "task.output_fragment" && event.body.contentIndex === 1));
    assert.ok(flow.items.some((entry) => entry.kind === "thinking" && entry.endedAt !== null));
    assert.deepEqual(flow.tools.find((entry) => entry.name === "edit")?.editStats, { added: 3, removed: 1 });

    const longEntry = history.entries.find((entry) => entry.truncated)!;
    assert.ok(longEntry.totalBytes > 48 * 1024);
    let offset = 0;
    let text = "";
    let last: HistoryEntryView;
    do {
      last = await client.request("read_history_entry", { session_id: completed.sessionId, entry_id: longEntry.entryId, offset, length: 48 * 1024 });
      assert.equal(last.offset, offset);
      assert.ok(last.text.length > 0);
      text += last.text;
      offset += Buffer.byteLength(last.text);
    } while (offset < last.totalBytes);
    assert.equal(Buffer.byteLength(text), longEntry.totalBytes);
    assert.ok(text.startsWith("长正文开头。") && text.endsWith("长正文结尾。"));
    flow.addHistory({ ...last, text, offset: 0, truncated: false });
    assert.equal(flow.items.filter((entry) => entry.kind === "message" && entry.entryId === longEntry.entryId).length, 1);
  } finally {
    client.close();
  }
});

test("合成会话里提交：明确拒绝、恢复草稿，不留待核实记录", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-pending-"));
  const store = new PendingRequestStore(dir);
  let app: TuiApp | null = null;
  const connection = new ControlConnection(
    { socketPath: "(demo)", token: "(demo)", clientFactory: async () => createDemoClient(() => {}, 60_000) },
    {
      onState: (s, detail) => app?.onConnectionState(s, detail),
      onSnapshot: (result, ctx) => app?.onSnapshot(result, ctx),
      onEvent: (event, kind) => app?.onEvent(event, kind),
    },
  );
  const state = new ViewState();
  const terminal = new FakeTerminal();
  const sessionId = "sess_demo0000000000000000";
  app = new TuiApp({ connection, guard: new SubmissionGuard(store, connection), pendingStore: store, state, terminal, initialSessionId: sessionId, onExit: () => {} });
  try {
    await app.start();
    await waitFor("上线", () => connection.state === "online");
    terminal.send("你好\r");
    const notes = () => state.openSession(sessionId).flow.items.filter((e) => e.kind === "note").map((e) => e.text);
    await waitFor("提交被拒绝", () => notes().includes("提交被拒绝：合成会话不支持：submit"));
    assert.equal(state.openSession(sessionId).draft, "你好", "草稿恢复");
    assert.equal(store.list().records.length, 0, "不留待核实记录");
  } finally {
    app.quit(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
