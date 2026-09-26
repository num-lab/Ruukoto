/**
 * issue 29：上下文前缀稳定。
 *
 * - 记忆按任务钉版：任务中新建的记忆从下一任务起注入；中途撤销的下一次调用剔除；
 *   拥有者中途修订的下一次调用按新版本注入，顺序保持钉住时的顺序；
 * - 继续来源与计划说明挪到当前任务输入之前：参考块 → 历史 → 继续来源 / 计划说明 → 当前任务；
 * - 无记忆变化、无任务级块时，前一次调用的消息序列是后一次的前缀（跨任务亦可）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RecordedRequest } from "./helpers/mock-provider.ts";
import { createProjectSession, lastUserText, routeResponder, startTestRuntime, taskStatus, waitFor, type TestRuntime } from "./helpers/testkit.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const OWNER_REF = [{ kind: "owner_note", note: "测试录入" }];

const textOf = (m: Record<string, unknown>): string =>
  typeof m.content === "string" ? m.content
    : Array.isArray(m.content) ? m.content.map((p: any) => (typeof p?.text === "string" ? p.text : JSON.stringify(p))).join("")
    : JSON.stringify(m.content);
const afterTool = (req: { messages: Array<Record<string, unknown>> }): boolean => req.messages.at(-1)?.role === "tool";
const isMemoryBlock = (m: Record<string, unknown>, needle: string): boolean => textOf(m).includes("[长期记忆") && textOf(m).includes(needle);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submit(t: TestRuntime, sessionId: string, requestId: string, input: string): Promise<any> {
  return t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: requestId, input });
}

async function waitStatus(t: TestRuntime, taskId: string, status: string): Promise<void> {
  await waitFor(`任务 ${status}`, async () => (await taskStatus(t.client, taskId)).task.status === status);
}

/** 请求中首个内容含 needle 的消息序号（-1 = 无）。 */
const indexOf = (req: RecordedRequest, needle: string): number => req.messages.findIndex((m) => textOf(m).includes(needle));
/** 正文恰为 text 的 user 消息序号（任务输入；继续来源块会引用原输入，不能按包含查找）。 */
const inputAt = (req: RecordedRequest, text: string): number => req.messages.findIndex((m) => m.role === "user" && textOf(m) === text);

test("集成：记忆按任务钉版——中途新建下一任务注入，中途撤销与修订下一次调用生效，顺序不变", async () => {
  const ids = { projectId: "", sessionId: "", entryId: "", m1: "", m2: "" };
  const t = await startTestRuntime(
    "prefix-mem",
    routeResponder([
      {
        match: /存记忆/,
        respond: async (req) => {
          if (afterTool(req)) return { kind: "text", text: "已存" };
          // 本次调用期间拥有者修订 M1、撤销 M2，Agent 新建 M3
          await t.client.request("save_memory", {
            memory_id: ids.m1, expected_version: 1, project_id: ids.projectId, category: "convention",
            content: "PIN-M1-V2", source_refs: OWNER_REF,
          });
          await t.client.request("revoke_memory", { memory_id: ids.m2, expected_version: 1 });
          return {
            kind: "tool_calls",
            calls: [{
              id: "ms1", name: "memory_save",
              arguments: {
                category: "experience", content: "PIN-M3", reason: "测试",
                source_refs: [{ kind: "history_entry", session_id: ids.sessionId, entry_id: ids.entryId }],
              },
            }],
          };
        },
      },
    ]),
  );
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    Object.assign(ids, { projectId, sessionId });
    const save = (content: string) => t.client.request<any>("save_memory", {
      project_id: projectId, category: "convention", content, source_refs: OWNER_REF,
    });
    // 钉住顺序（updated_at 倒序）为 M2、M0、M1；修订后 M1 最新，不钉版就会排到最前
    ids.m1 = (await save("PIN-M1-V1")).id;
    await sleep(5);
    await save("PIN-M0");
    await sleep(5);
    ids.m2 = (await save("PIN-M2")).id;

    const seed = await submit(t, sessionId, "r-seed", "记暗号：蓝色灯塔");
    await waitStatus(t, seed.id, "completed");
    ids.entryId = (await t.client.request<any>("search_history", { query: "蓝色灯塔", project_id: projectId })).hits[0].entryId;

    const before = t.server.calls.length;
    const task = await submit(t, sessionId, "r-save", "存记忆");
    await waitStatus(t, task.id, "completed");
    const [first, second] = t.server.calls.slice(before);
    assert.ok(first && second, "存记忆任务应有两次调用");
    assert.ok(indexOf(first, "PIN-M2") >= 0 && indexOf(first, "PIN-M2") < indexOf(first, "PIN-M0") && indexOf(first, "PIN-M0") < indexOf(first, "PIN-M1-V1"));

    const secondText = JSON.stringify(second.messages);
    assert.ok(secondText.includes("PIN-M1-V2") && !secondText.includes("PIN-M1-V1"), "中途修订的记忆按新版本注入");
    assert.equal(indexOf(second, "PIN-M2"), -1, "中途撤销的记忆下一次调用即剔除");
    assert.ok(indexOf(second, "PIN-M0") >= 0 && indexOf(second, "PIN-M0") < indexOf(second, "PIN-M1-V2"), "排列保持钉住时的顺序");
    assert.equal((await t.client.request<any>("list_memories", { project_id: projectId })).memories.length, 4, "memory_save 已写入");
    assert.ok(!second.messages.some((m) => isMemoryBlock(m, "PIN-M3")), "本任务新建的记忆不进入本任务视图");

    const next = await submit(t, sessionId, "r-next", "下一任务");
    await waitStatus(t, next.id, "completed");
    const nextCall = t.server.calls.at(-1)!;
    assert.ok(nextCall.messages.some((m) => isMemoryBlock(m, "PIN-M3")), "下一任务注入新记忆");
    assert.ok(indexOf(nextCall, "PIN-M1-V2") >= 0 && indexOf(nextCall, "PIN-M2") === -1);
  } finally {
    await t.shutdown();
  }
});

test("集成：继续来源与计划说明位于历史之后、当前任务输入之前；普通任务没有这两块", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const t = await startTestRuntime(
    "prefix-order",
    routeResponder([
      { match: /^\/plan 调研登录页/, respond: async () => { await gate; return { kind: "text" as const, text: "不应到达" }; } },
    ]),
  );
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await t.client.request("save_memory", { project_id: projectId, category: "preference", content: "ORDER-MEM", source_refs: OWNER_REF });
    const warm = await submit(t, sessionId, "r-warm", "普通任务一");
    await waitStatus(t, warm.id, "completed");

    const plan = await submit(t, sessionId, "r-plan", "/plan 调研登录页");
    await waitStatus(t, plan.id, "running");
    await t.client.request("interrupt", { task_id: plan.id });
    await waitStatus(t, plan.id, "interrupted");
    release();

    const before = t.server.calls.length;
    const cont = await t.client.request<any>("continue", {
      session_id: sessionId, model_selection: MODEL, task_id: plan.id, request_id: "r-cont", input: "继续",
    });
    await waitStatus(t, cont.id, "completed");
    const contCalls = t.server.calls.slice(before);
    assert.ok(contCalls.length >= 1);
    for (const call of contCalls) {
      const input = inputAt(call, "继续");
      assert.ok(input > 0, "当前任务输入在视图中");
      assert.ok(textOf(call.messages[input - 2]!).startsWith(`[继续来源：本任务继续已中断任务 ${plan.id}`), "继续来源紧邻计划说明之前");
      assert.ok(textOf(call.messages[input - 1]!).startsWith("[计划模式"), "计划说明紧邻当前任务输入");
      const history = inputAt(call, "/plan 调研登录页");
      assert.ok(indexOf(call, "ORDER-MEM") < inputAt(call, "普通任务一") && inputAt(call, "普通任务一") < history && history < input - 2,
        "参考块 → 历史 → 任务级块");
    }

    const normal = await submit(t, sessionId, "r-normal", "普通任务二");
    await waitStatus(t, normal.id, "completed");
    const normalCall = t.server.calls.at(-1)!;
    assert.equal(lastUserText(normalCall), "普通任务二");
    assert.equal(indexOf(normalCall, "[继续来源"), -1, "普通任务没有继续来源");
    assert.equal(indexOf(normalCall, "[计划模式"), -1, "普通任务没有计划说明");
  } finally {
    release();
    await t.shutdown();
  }
});

test("集成：无记忆变化与任务级块时，同一会话连续调用的消息序列逐次为前缀（跨任务，指令与技能版本变化亦然）", async () => {
  const t = await startTestRuntime(
    "prefix-stable",
    routeResponder([
      { match: /查记忆/, respond: (req) => afterTool(req)
        ? { kind: "text", text: "查完" }
        : { kind: "tool_calls", calls: [{ id: "ml1", name: "memory_list", arguments: {} }] } },
    ]),
  );
  try {
    const skillFile = path.join(t.dirs.agentDir, "skills", "alpha", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "---\nname: alpha\ndescription: ALPHA-DESC\n---\nBODY-V1");
    fs.writeFileSync(path.join(t.work[0]!, "TEAM.md"), "项目约定：提交信息用中文");
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await t.client.request("set_project_instructions", { project_id: projectId, files: ["TEAM.md"] });
    await t.client.request("save_memory", { project_id: projectId, category: "preference", content: "STABLE-MEM", source_refs: OWNER_REF });

    const a = await submit(t, sessionId, "r-a", "查记忆");
    await waitStatus(t, a.id, "completed");
    // 只改技能正文：技能库版本变化，目录文本不变
    fs.writeFileSync(skillFile, "---\nname: alpha\ndescription: ALPHA-DESC\n---\nBODY-V2");
    const b = await submit(t, sessionId, "r-b", "第二个任务");
    await waitStatus(t, b.id, "completed");

    const calls = t.server.calls;
    assert.equal(calls.length, 3);
    const text = JSON.stringify(calls[0]!.messages);
    assert.ok(text.includes("[项目指令]") && text.includes("[技能目录]") && text.includes("STABLE-MEM"), "三类参考块都在视图中");
    for (let i = 0; i + 1 < calls.length; i++) {
      const prev = calls[i]!.messages;
      assert.deepEqual(calls[i + 1]!.messages.slice(0, prev.length), prev, `第 ${i + 1} 次调用是第 ${i + 2} 次的前缀`);
    }
    const [ra, rb] = await Promise.all([a, b].map(async (task) =>
      (await t.client.request<any>("list_selection_records", { task_id: task.id })).records[0]));
    assert.notEqual(ra.instructionVersion, rb.instructionVersion, "每个任务的指令版本（产物 id）不同");
    assert.notEqual(ra.skillVersion, rb.skillVersion, "技能正文变化后技能库版本不同");
  } finally {
    await t.shutdown();
  }
});

test("集成：记忆钉版读取失败时阻断发送，不以缺记忆的视图继续", async () => {
  const t = await startTestRuntime("prefix-memfail", routeResponder([]));
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const saved = await t.client.request<any>("save_memory", { project_id: projectId, category: "preference", content: "BROKEN-MEM", source_refs: OWNER_REF });
    t.runtime.store.db.prepare("UPDATE memory_versions SET source_refs = 'not-json' WHERE memory_id = ?").run(saved.id);
    const task = await submit(t, sessionId, "r-fail", "普通任务");
    await waitFor("任务终态", async () => (await taskStatus(t.client, task.id)).task.status !== "running" &&
      (await taskStatus(t.client, task.id)).task.status !== "queued");
    assert.equal(t.server.calls.length, 0, "没有发出模型请求");
    assert.notEqual((await taskStatus(t.client, task.id)).task.status, "completed");
  } finally {
    await t.shutdown();
  }
});
