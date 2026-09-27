import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { ContextExperimentRecord, SelectionRecord, SelectionUsage } from "../src/core/types.ts";
import { selectionBreakdown } from "../src/agent/context-selector.ts";
import { contextBarLines } from "../src/tui/app.ts";

const experiment: ContextExperimentRecord = {
  status: "applied",
  strategy: "jev-v1",
  requestedModel: "jev-1.13.0",
  model: "jev-1.13.0",
  configVersion: 2,
  threshold: 0.5,
  elapsedMs: 12,
  requestSent: true,
  usage: { inputTokens: 100, outputTokens: 20 },
  estimatedCost: { usd: 0.0000042, inputUsdPerMillion: 0.042, priceDate: "2026-09-25" },
  fallbackReason: null,
  candidates: [{ id: "turn_0", indices: [0, 1, 2], probability: 0.95 }],
  baselineIncludedIndices: [3],
};

function record(id: string, detail: ContextExperimentRecord | null = null): SelectionRecord {
  return {
    id, taskId: "task_fixture", sessionId: "session_fixture", callIndex: 1,
    strategy: detail?.status === "applied" ? "jev-v1" : "deterministic-v1",
    configVersion: 1, model: "mock/mock-model", totalMessages: 4,
    includedIndices: [0, 1, 2, 3], excluded: [], includedMemories: [], excludedMemories: [],
    instructionVersion: "", skillVersion: "", cappedToolResults: [], estimates: { mandatoryTurn: 100 },
    budget: 1000, estimatedTotal: 100, usage: null, experiment: detail,
    promptArtifactId: null, windowSnapshot: null, checkpointId: null, createdAt: "2026-09-25T00:00:00.000Z",
  };
}

test("Jev 记录：真实旧表补列默认 null；实验、取消事件和主模型缓存费用跨重启保留", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-jev-records-"));
  let db: Db | undefined;
  try {
    db = new Db(root);
    let store = new Store(db);
    const legacy = record("sel_legacy");
    store.withTx(() => store.insertSelectionRecord(legacy));
    db.exec("ALTER TABLE selection_records DROP COLUMN experiment");
    db.close();
    db = new Db(root);
    store = new Store(db);
    assert.deepEqual(store.getSelectionRecord(legacy.id), legacy, "补列不修改旧选择事实");

    const current = record("sel_jev", experiment);
    const usage: SelectionUsage = {
      input: 200, output: 30, cacheRead: 100, cacheWrite: 20,
      cost: { input: 0.01, output: 0.002, cacheRead: 0.001, cacheWrite: 0.003, total: 0.016 },
    };
    store.withTx(() => {
      store.insertSelectionRecord(current);
      store.setSelectionRecordUsage(current.id, usage);
      store.appendEvent({
        type: "task.context_experiment", taskId: "task_canceled", sessionId: "session_fixture",
        experiment: { ...experiment, status: "canceled", usage: null, estimatedCost: null, fallbackReason: "canceled" },
      }, { taskId: "task_canceled", sessionId: "session_fixture" });
    });
    db.close();
    db = new Db(root);
    store = new Store(db);
    assert.deepEqual(store.getSelectionRecord(current.id), { ...current, usage });
    assert.equal(store.getSelectionRecord(legacy.id)!.experiment, null);
    const event = store.getEventsAfter(0).find(e => e.body.type === "task.context_experiment")!;
    assert.equal(event.taskId, "task_canceled");
    assert.equal(event.sessionId, "session_fixture");
    assert.equal(event.body.type, "task.context_experiment");
    if (event.body.type === "task.context_experiment") {
      assert.equal(event.body.experiment.status, "canceled");
      assert.equal(event.body.experiment.estimatedCost, null, "已发送但没有用量不能记为免费");
    }
    assert.deepEqual(store.listSelectionRecordsByTask("task_canceled"), [], "取消记录不伪造主模型调用");
  } finally {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/context 显示实验策略与回退；未知费用和零请求分别表述，旧记录仍可渲染", () => {
  const render = (detail: ContextExperimentRecord | null) => {
    const value = record("sel_view", detail);
    const lines = contextBarLines(value, selectionBreakdown(value), 180);
    return stripTerminalSequences(lines.join("\n"));
  };
  assert.doesNotMatch(render(null), /Jev/);
  assert.match(render(experiment), /Jev 已采用/);
  assert.match(render(experiment), /费用估算 US\$0\.000004200（2026-09-25 单价）/);
  const failed = render({ ...experiment, status: "fallback", model: null, usage: null, estimatedCost: null, fallbackReason: "timeout" });
  assert.match(failed, /策略 deterministic-v1 · Jev 已回退/);
  assert.match(failed, /已发送，用量未知；费用未估算/);
  assert.match(failed, /原因：timeout/);
  assert.match(render({ ...experiment, status: "skipped", requestSent: false, usage: null, estimatedCost: null }), /未发送请求；费用未估算/);
});
