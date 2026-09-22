/**
 * 合成调试会话（`ruukoto tui --demo`）：假客户端本身的自检。
 *
 * 目的：这份数据是给界面调试用的，一旦落后于事件类型定义就失去意义。
 * 这里断言它覆盖 PersistentEventBody 的全部 type、seq 连续、且不产生
 * 真实副作用（写操作一律拒绝）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import type { ControlClient } from "../src/control/client.ts";
import type { PersistentEvent } from "../src/core/types.ts";
import { createDemoClient } from "../src/tui/demo-session.ts";

/** 从类型定义抽出全部事件 type 字面量（新增事件类型时必须同步 demo 数据）。 */
function declaredEventTypes(): string[] {
  const src = fs.readFileSync(new URL("../src/core/types.ts", import.meta.url), "utf8");
  const start = src.indexOf("export type PersistentEventBody");
  const end = src.indexOf("export interface PersistentEvent");
  assert.ok(start >= 0 && end > start, "未能定位 PersistentEventBody 定义");
  return [...src.slice(start, end).matchAll(/\{ type: "([a-z_.]+)"/g)].map((m) => m[1]!);
}

/** 收集 demo 客户端推送的全部事件（等事件流自然结束）。 */
async function collect(client: ControlClient): Promise<PersistentEvent[]> {
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

test("合成会话不产生真实副作用：写操作被拒绝", async () => {
  const client = createDemoClient(() => {});
  try {
    await client.handshake();
    // 读操作有静态应答
    const page = await client.request<{ entries: unknown[] }>("read_history", { session_id: "sess_demo0000000000000000" });
    assert.ok(page.entries.length > 0, "历史应为非空");
    const models = await client.request<{ models: unknown[] }>("list_models", {});
    assert.ok(models.models.length > 0, "模型列表应为非空");
    // 写操作必须明确失败，不得静默成功
    for (const op of ["submit", "create_project", "create_session", "respond_confirmation", "stop"]) {
      await assert.rejects(() => client.request(op, {}), /合成会话不支持写操作/, `${op} 应被拒绝`);
    }
  } finally {
    client.close();
  }
});
