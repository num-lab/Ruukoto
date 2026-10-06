import assert from "node:assert/strict";
import test from "node:test";
import { buildHostToolSet, hostCallFor, type HostToolRuntime } from "../src/agent/host-tool-families.ts";

function runtime(): HostToolRuntime {
  return {} as HostToolRuntime;
}

test("宿主工具族从同一 names 清单构建并拒绝重复或漂移", () => {
  const one = { category: "skills" as const, names: ["skill"] as const, build: () => [{ name: "skill" }] as any };
  const two = { category: "coding" as const, names: ["todo_write"] as const, build: () => [{ name: "todo_write" }] as any };
  const built = buildHostToolSet([one, two], runtime());
  assert.deepEqual([...built.names], ["skill", "todo_write"]);
  assert.deepEqual(built.tools.map((tool) => tool.name), ["skill", "todo_write"]);

  assert.throws(
    () => buildHostToolSet([{ ...one, build: () => [{ name: "other" }] as any }, two], runtime()),
    /声明与构建结果不一致/,
  );
  assert.throws(
    () => buildHostToolSet([one, { ...two, names: ["skill"] as const }], runtime()),
    /工具名重复/,
  );
});

test("宿主调用句柄按 sdkCallId 保持独立上下文", () => {
  const contexts = new Map([
    ["call-a", { taskId: "task-a", sessionId: "session-a", projectId: "project", hostOpId: "op-a" }],
    ["call-b", { taskId: "task-b", sessionId: "session-b", projectId: "project", hostOpId: "op-b" }],
  ]);
  const released: string[] = [];
  const bindCall = (id: string) => ({
    context: contexts.get(id) ?? null,
    release: () => released.push(id),
  });
  const a = hostCallFor(bindCall, () => null, "call-a");
  const b = hostCallFor(bindCall, () => null, "call-b");
  assert.equal(a.context?.taskId, "task-a");
  assert.equal(b.context?.taskId, "task-b");
  a.release();
  assert.equal(b.context?.taskId, "task-b");
  b.release();
  assert.deepEqual(released, ["call-a", "call-b"]);
  b.release();
  assert.deepEqual(released, ["call-a", "call-b"]);
});
