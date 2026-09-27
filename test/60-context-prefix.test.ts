/**
 * issue 29：上下文前缀稳定（经模型上下文组装的模块接口，不起 Runtime）。
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
import { ContextSendBlocked } from "../src/agent/context-assembly.ts";
import { loadSkillLibrary } from "../src/agent/skills.ts";
import { startAssemblyKit } from "./helpers/testkit.ts";

const OWNER_REF = [{ kind: "owner_note" as const, note: "测试录入" }];

let clock = Date.parse("2026-09-27T00:00:00.000Z");
const user = (text: string) => ({ role: "user", content: text, timestamp: clock++ });
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: clock++ });
const call = (id: string, name: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse", timestamp: clock++ });
const result = (id: string, name: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: clock++ });
const textOf = (m: any): string => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? JSON.stringify(p)).join(""));
const isMemoryBlock = (m: any, needle: string): boolean => textOf(m).includes("[长期记忆") && textOf(m).includes(needle);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 视图中首个内容含 needle 的消息序号（-1 = 无）。 */
const indexOf = (view: any[], needle: string): number => view.findIndex((m) => textOf(m).includes(needle));
/** 正文恰为 text 的 user 消息序号（任务输入；继续来源块会引用原输入，不能按包含查找）。 */
const inputAt = (view: any[], text: string): number => view.findIndex((m) => m.role === "user" && textOf(m) === text);

test("组装：记忆按任务钉版——中途新建下一任务注入，中途撤销与修订下一次调用生效，顺序不变", async () => {
  const kit = await startAssemblyKit("prefix-mem");
  try {
    const { projectId, session } = kit.project();
    const save = (content: string) => kit.deps.memories.create({ projectId, category: "convention", content, sourceRefs: OWNER_REF, author: "owner" });
    // 钉住顺序（updated_at 倒序）为 M2、M0、M1；修订后 M1 最新，不钉版就会排到最前
    const m1 = save("PIN-M1-V1");
    await sleep(5);
    save("PIN-M0");
    await sleep(5);
    const m2 = save("PIN-M2");

    const history = [user("记暗号：蓝色灯塔"), reply("好"), user("存记忆")];
    const assembly = kit.begin(kit.task(session, "存记忆"), session);
    const first = (await kit.send(assembly, history)).view;
    assert.ok(indexOf(first, "PIN-M2") >= 0 && indexOf(first, "PIN-M2") < indexOf(first, "PIN-M0") && indexOf(first, "PIN-M0") < indexOf(first, "PIN-M1-V1"));

    // 两次调用之间：拥有者修订 M1、撤销 M2，本任务新建 M3
    kit.deps.memories.revise({ memoryId: m1.id, expectedVersion: 1, content: "PIN-M1-V2", sourceRefs: OWNER_REF, author: "owner" });
    kit.deps.memories.revoke({ memoryId: m2.id, expectedVersion: 1, author: "owner" });
    save("PIN-M3");
    const turn = [...history, call("ms1", "memory_save"), result("ms1", "memory_save", "已保存")];
    const second = (await kit.send(assembly, turn)).view;
    const secondText = JSON.stringify(second);
    assert.ok(secondText.includes("PIN-M1-V2") && !secondText.includes("PIN-M1-V1"), "中途修订的记忆按新版本注入");
    assert.equal(indexOf(second, "PIN-M2"), -1, "中途撤销的记忆下一次调用即剔除");
    assert.ok(indexOf(second, "PIN-M0") >= 0 && indexOf(second, "PIN-M0") < indexOf(second, "PIN-M1-V2"), "排列保持钉住时的顺序");
    assert.ok(!second.some((m) => isMemoryBlock(m, "PIN-M3")), "本任务新建的记忆不进入本任务视图");

    const next = (await kit.send(kit.begin(kit.task(session, "下一任务"), session), [...turn, reply("已存"), user("下一任务")])).view;
    assert.ok(next.some((m) => isMemoryBlock(m, "PIN-M3")), "下一任务注入新记忆");
    assert.ok(indexOf(next, "PIN-M1-V2") >= 0 && indexOf(next, "PIN-M2") === -1);
  } finally {
    await kit.close();
  }
});

test("组装：继续来源与计划说明位于历史之后、当前任务输入之前；普通任务没有这两块", async () => {
  const kit = await startAssemblyKit("prefix-order");
  try {
    const { projectId, session } = kit.project();
    kit.deps.memories.create({ projectId, category: "preference", content: "ORDER-MEM", sourceRefs: OWNER_REF, author: "owner" });
    const plan = kit.task(session, "/plan 调研登录页");
    const history = [user("普通任务一"), reply("done"), user("/plan 调研登录页")];

    const view = (await kit.send(kit.begin(kit.task(session, "继续", plan.id), session, { plan: true }), [...history, user("继续")])).view;
    const input = inputAt(view, "继续");
    assert.ok(input > 0, "当前任务输入在视图中");
    assert.ok(textOf(view[input - 2]).startsWith(`[继续来源：本任务继续已中断任务 ${plan.id}`), "继续来源紧邻计划说明之前");
    assert.ok(textOf(view[input - 1]).startsWith("[计划模式"), "计划说明紧邻当前任务输入");
    const planInput = inputAt(view, "/plan 调研登录页");
    assert.ok(indexOf(view, "ORDER-MEM") >= 0 && indexOf(view, "ORDER-MEM") < inputAt(view, "普通任务一") &&
      inputAt(view, "普通任务一") < planInput && planInput < input - 2, "参考块 → 历史 → 任务级块");

    const normal = (await kit.send(kit.begin(kit.task(session, "普通任务二"), session), [...history, user("继续"), reply("ok"), user("普通任务二")])).view;
    assert.equal(textOf(normal.at(-1)), "普通任务二");
    assert.equal(indexOf(normal, "[继续来源"), -1, "普通任务没有继续来源");
    assert.equal(indexOf(normal, "[计划模式"), -1, "普通任务没有计划说明");
  } finally {
    await kit.close();
  }
});

test("组装：无记忆变化与任务级块时，同一会话连续调用的消息序列逐次为前缀（跨任务，指令与技能版本变化亦然）", async () => {
  const kit = await startAssemblyKit("prefix-stable");
  try {
    const skillFile = path.join(kit.dirs.agentDir, "skills", "alpha", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "---\nname: alpha\ndescription: ALPHA-DESC\n---\nBODY-V1");
    fs.writeFileSync(path.join(kit.work[0]!, "TEAM.md"), "项目约定：提交信息用中文");
    const { projectId, session } = kit.project();
    kit.store.setProjectInstructionFiles(projectId, ["TEAM.md"]);
    kit.deps.memories.create({ projectId, category: "preference", content: "STABLE-MEM", sourceRefs: OWNER_REF, author: "owner" });
    // 技能目录只在本任务可用 skill 工具时注入；技能库由 driver 在任务开始钉版后交进来
    const tools = [{ name: "skill", description: "读取技能", parameters: {} }];
    const begin = (input: string) => kit.begin(kit.task(session, input), session, { skills: loadSkillLibrary(kit.dirs.agentDir) });

    const a = begin("查记忆");
    const turn = [user("查记忆"), call("ml1", "memory_list"), result("ml1", "memory_list", "[]")];
    const calls = [await kit.send(a, turn.slice(0, 1), { tools }), await kit.send(a, turn, { tools })];
    // 只改技能正文：技能库版本变化，目录文本不变
    fs.writeFileSync(skillFile, "---\nname: alpha\ndescription: ALPHA-DESC\n---\nBODY-V2");
    calls.push(await kit.send(begin("第二个任务"), [...turn, reply("查完"), user("第二个任务")], { tools }));

    const text = JSON.stringify(calls[0]!.view);
    assert.ok(text.includes("[项目指令]") && text.includes("[技能目录]") && text.includes("STABLE-MEM"), "三类参考块都在视图中");
    for (let i = 0; i + 1 < calls.length; i++) {
      const prev = calls[i]!.view;
      assert.deepEqual(calls[i + 1]!.view.slice(0, prev.length), prev, `第 ${i + 1} 次调用是第 ${i + 2} 次的前缀`);
    }
    assert.notEqual(calls[0]!.record.instructionVersion, calls[2]!.record.instructionVersion, "每个任务的指令版本（产物 id）不同");
    assert.notEqual(calls[0]!.record.skillVersion, calls[2]!.record.skillVersion, "技能正文变化后技能库版本不同");
  } finally {
    await kit.close();
  }
});

test("组装：记忆钉版读取失败时拒绝发送，不以缺记忆的视图继续", async () => {
  const kit = await startAssemblyKit("prefix-memfail");
  try {
    const { projectId, session } = kit.project();
    const saved = kit.deps.memories.create({ projectId, category: "preference", content: "BROKEN-MEM", sourceRefs: OWNER_REF, author: "owner" });
    kit.store.db.prepare("UPDATE memory_versions SET source_refs = 'not-json' WHERE memory_id = ?").run(saved.id);
    const task = kit.task(session, "普通任务");
    await assert.rejects(kit.send(kit.begin(task, session), [user("普通任务")]),
      (err: any) => err instanceof ContextSendBlocked && err.code === "context_selection_failed" && err.message.includes("上下文选择失败"),
      "资料读取失败不记成超预算");
    assert.equal(kit.store.listSelectionRecordsByTask(task.id).length, 0, "不落选择记录");
  } finally {
    await kit.close();
  }
});
