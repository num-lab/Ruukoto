/**
 * 桌面浏览器宿主（mygo-agent-browser 步骤 4）：资格判定、闸门事件投影、
 * 接管等待/取消、串行与代次校验、快照引用作废、交还观察。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopBrowserError, DesktopBrowserManager, type DesktopBrowserEvent } from "@ruukoto/agent/desktop-browser.ts";
import { taskToolSet } from "@ruukoto/agent/tool-availability.ts";
import { startAssemblyKit } from "./helpers/testkit.ts";
import { randomId } from "@ruukoto/core/types.ts";
import type { Task } from "@ruukoto/core/types.ts";
import type { Store } from "@ruukoto/core/store.ts";

const CONN = "conn-1";

async function kit() {
  return startAssemblyKit("dbm");
}

function managerWith(store: Store, calls?: { log: { op: string; params: Record<string, unknown> }[]; impl?: (params: Record<string, unknown>) => Promise<unknown> }) {
  return new DesktopBrowserManager({
    store,
    call: () => calls
      ? async (connectionId, params) => { assert.equal(connectionId, CONN); calls.log.push({ op: String(params["op"]), params }); return calls.impl ? calls.impl(params) : { ok: true, value: { value: {}, generation: 1 } }; }
      : null,
  });
}

function ev(session: string, extra: Partial<DesktopBrowserEvent>): DesktopBrowserEvent {
  return { session, kind: "nav", generation: 1, ...extra };
}

function fullTask(store: Store, sessionId: string, extra: Record<string, unknown> = {}): Task {
  return store.withTx(() => store.insertQueuedTask({ sessionId, requestId: randomId("r"), input: "p", accessMode: "full_access", modelSelection: null, submissionDigest: randomId("d"), ...extra }).task);
}

test("资格：来源绑定 + dev 会话 + 完全访问，缺一即不可", async () => {
  const t = await kit();
  try {
    const { session } = t.project();
    assert.equal(t.store.getSessionIdentity(session.id)?.kind, "dev");
    const m = managerWith(t.store);
    const task = fullTask(t.store, session.id);
    assert.equal(m.eligible(task), false); // 未绑定
    t.store.withTx(() => t.store.bindTaskBrowser(task.id, CONN));
    assert.equal(m.eligible(task), true);

    const planned = fullTask(t.store, session.id, { planMode: true, accessMode: "auto-review" });
    t.store.withTx(() => t.store.bindTaskBrowser(planned.id, CONN));
    assert.equal(m.eligible(planned), false);

    const child = fullTask(t.store, session.id, { parentTaskId: task.id });
    t.store.withTx(() => t.store.bindTaskBrowser(child.id, CONN));
    assert.equal(m.eligible(child), false);

    const restricted = fullTask(t.store, session.id, { accessMode: "confirm" });
    t.store.withTx(() => t.store.bindTaskBrowser(restricted.id, CONN));
    assert.equal(m.eligible(restricted), false);
  } finally { await t.close(); }
});

test("任务工具集：desktop_browser 需显式开放；browser 与 desktop_browser 由调用方互斥", async () => {
  const base = { registered: ["browser", "desktop_browser"], plan: false, webSearchEnabled: true, mcpEffect: () => undefined };
  const open = taskToolSet({ ...base, browserEnabled: false, desktopBrowserEnabled: true });
  assert.equal(open.allowed.has("desktop_browser"), true);
  assert.equal(open.allowed.has("browser"), false);
  const closed = taskToolSet({ ...base, browserEnabled: true, desktopBrowserEnabled: false });
  assert.equal(closed.allowed.has("browser"), true);
  assert.match(closed.reasonFor("desktop_browser"), /MyGo 来源/);
});

test("闸门事件投影：交还 pendingReturn 一次消费，断线按 gone 释放等待", async () => {
  const t = await kit();
  try {
    const { session } = t.project();
    const task = fullTask(t.store, session.id);
    t.store.withTx(() => t.store.bindTaskBrowser(task.id, CONN));
    const m = managerWith(t.store);

    m.onEvent(CONN, ev(session.id, { kind: "nav", generation: 1 }));
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 1, owned: true }));
    // 首次见到 owned 不算交还
    assert.equal(m.takePendingReturn(task), null);
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 2, owned: false }));
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 3, owned: true }));
    const ret = m.takePendingReturn(task);
    assert.deepEqual(ret, { generation: 3 });
    assert.equal(m.takePendingReturn(task), null); // 只触发一次

    // 断线：状态 gone，等待释放为 gone
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 4, owned: false }));
    const waiting = m.awaitGate(task, () => false);
    m.onDisconnect(CONN);
    assert.equal(await waiting, "gone");
    assert.equal(m.state(task)?.gone, true);
  } finally { await t.close(); }
});

test("命令串行与闸门：接管中等待交还才发送；取消先 canceled 不发送", async () => {
  const t = await kit();
  try {
    const { session } = t.project();
    const task = fullTask(t.store, session.id);
    t.store.withTx(() => t.store.bindTaskBrowser(task.id, CONN));
    const calls: { op: string; params: Record<string, unknown> }[] = [];
    const m = managerWith(t.store, { log: calls });

    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 1, owned: true }));
    const first = m.command(task, "navigate", { url: "https://a.test" });
    await first;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.params["generation"], 1);

    // 接管：命令挂起不发送；交还后继续
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 2, owned: false }));
    const held = m.command(task, "navigate", { url: "https://b.test" });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(calls.length, 1);
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 3, owned: true }));
    await held;
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.params["generation"], 3);

    // 接管中取消：未发送
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 4, owned: false }));
    await assert.rejects(m.command(task, "navigate", { url: "https://c.test" }, { stopped: () => true }), (e: unknown) => e instanceof DesktopBrowserError && (e as DesktopBrowserError).code === "canceled");
    assert.equal(calls.length, 2);
  } finally { await t.close(); }
});

test("串行：同页命令按序；页面消亡与未绑定拒绝", async () => {
  const t = await kit();
  try {
    const { session } = t.project();
    const task = fullTask(t.store, session.id);
    t.store.withTx(() => t.store.bindTaskBrowser(task.id, CONN));
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const m = new DesktopBrowserManager({
      store: t.store,
      call: () => async (_c, params) => { order.push(String(params["op"])); await new Promise<void>(r => gates.push(r)); return { ok: true, value: { value: {}, generation: 1 } }; },
    });
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 1, owned: true }));
    const a = m.command(task, "navigate", { url: "https://a" });
    const b = m.command(task, "navigate", { url: "https://b" });
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(order, ["navigate"]); // b 排队未发
    gates[0]!(); await a;
    await new Promise(r => setTimeout(r, 10));
    assert.equal(order.length, 2);
    gates[1]!(); await b;

    // 页面消亡：拒绝 disconnected
    m.onEvent(CONN, ev(session.id, { kind: "closed", generation: 5 }));
    await assert.rejects(m.command(task, "navigate", { url: "https://x" }), (e: unknown) => (e as DesktopBrowserError).code === "disconnected");

    // 未绑定任务：not_bound
    const other = fullTask(t.store, session.id);
    await assert.rejects(m.command(other, "navigate", { url: "https://x" }), (e: unknown) => (e as DesktopBrowserError).code === "not_bound");
  } finally { await t.close(); }
});

test("快照引用按代次绑定；观察返回代次与正文；效果未知不重发", async () => {
  const t = await kit();
  try {
    const { session } = t.project();
    const task = fullTask(t.store, session.id);
    t.store.withTx(() => t.store.bindTaskBrowser(task.id, CONN));
    const m = new DesktopBrowserManager({
      store: t.store,
      call: () => async () => ({ ok: true, value: { value: JSON.stringify({ url: "https://a", title: "A", text: "正文", refs: { e1: "button 确定" } }), generation: 3 } }),
    });
    m.onEvent(CONN, ev(session.id, { kind: "gate", generation: 2, owned: true }));
    m.noteSnapshot(task, 2, ["e1"]);
    m.requireRef(task, "e1"); // 代次匹配通过
    // 导航代次翻转：引用作废
    m.onEvent(CONN, ev(session.id, { kind: "nav", generation: 3 }));
    assert.throws(() => m.requireRef(task, "e1"), (e: unknown) => e instanceof DesktopBrowserError && (e as DesktopBrowserError).code === "stale_ref");

    const obs = await m.observe(task);
    assert.equal(obs.generation, 3);
    assert.equal(obs.url, "https://a");
    assert.match(obs.text, /正文/);

    // 效果未知：error.outcome=unknown 不静默重试
    const failing = new DesktopBrowserManager({ store: t.store, call: () => async () => ({ ok: false, error: { code: "eval_failed", outcome: "unknown", message: "页面脚本失败" } }) });
    failing.onEvent(CONN, ev(session.id, { kind: "gate", generation: 3, owned: true }));
    await assert.rejects(failing.command(task, "eval", { script: "1" }), (e: unknown) => e instanceof DesktopBrowserError && e.effectUnknown === true);
  } finally { await t.close(); }
});

test("交还观察经会话 marker 投影为参考块，且只投影一次", async () => {
  const t = await kit();
  try {
    const { session } = t.project();
    const task = t.task(session, "x");
    const { promises: fs } = await import("node:fs");
    const file = `${t.dirs.dataDir}/obs-session.jsonl`;
    const marker = { id: "e1", type: "custom", customType: "ruukoto_browser_observation", data: { taskId: task.id, observationId: "obs-1", generation: 7, url: "https://a", title: "A", text: "页面正文", unavailable: null } };
    await fs.writeFile(file, JSON.stringify(marker) + "\n");
    const { beginContextAssembly } = await import("@ruukoto/agent/context-assembly.ts");
    const assembly = beginContextAssembly({ task, session, accessor: { kind: "agent", projectId: session.projectId }, restricted: false, plan: false, skills: null }, t.deps);
    const sdk = { systemPrompt: "sys", tools: [], model: t.model, sessionFile: file };
    const view = (await assembly.assemble([{ role: "user", content: [{ type: "text", text: "问" }] }], sdk))?.messages ?? [];
    const text = JSON.stringify(view);
    assert.match(text, /桌面浏览器观察/);
    assert.match(text, /页面正文/);
    assert.match(text, /代次 7/);
    assert.equal(assembly.browserObservationDelivered, "obs-1");
    // 同一观察不重复投影
    const view2 = (await assembly.assemble([{ role: "user", content: [{ type: "text", text: "问2" }] }], sdk))?.messages ?? [];
    assert.doesNotMatch(JSON.stringify(view2), /桌面浏览器观察/);
    // 不可观察投影不可用事实而非伪造内容
    const marker2 = { id: "e2", type: "custom", customType: "ruukoto_browser_observation", data: { taskId: task.id, observationId: "obs-2", generation: 8, unavailable: "页面已关闭（disconnected）" } };
    await fs.writeFile(file, JSON.stringify(marker) + "\n" + JSON.stringify(marker2) + "\n");
    const view3 = (await assembly.assemble([{ role: "user", content: [{ type: "text", text: "问3" }] }], sdk))?.messages ?? [];
    assert.match(JSON.stringify(view3), /交还后观察不可得/);
  } finally { await t.close(); }
});
