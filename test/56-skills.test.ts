/**
 * issue 22：技能系统（全局技能库、钉版目录注入、skill 工具、/skill 显式调用）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { expandSkillCommand, loadSkillLibrary, readSkill } from "../src/agent/skills.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import { createProjectSession, lastUserText, startTestRuntime, taskStatus, waitFor, type TestRuntime } from "./helpers/testkit.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

function writeSkill(dir: string, frontmatter: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

function toolNames(req: { tools?: Array<Record<string, unknown>> }): string[] {
  return (req.tools ?? []).map((t: any) => t?.function?.name ?? t?.name);
}

function lastToolContent(req: { messages: Array<Record<string, unknown>> }): string | null {
  const last = req.messages.at(-1) as any;
  return last?.role === "tool" ? String(typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : null;
}

async function submit(t: TestRuntime, sessionId: string, requestId: string, input: string, extra: Record<string, unknown> = {}): Promise<any> {
  return t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: requestId, input, ...extra });
}

async function waitDone(t: TestRuntime, taskId: string): Promise<any> {
  await waitFor("任务终态", async () => ["completed", "failed", "interrupted", "canceled"].includes((await taskStatus(t.client, taskId)).task.status));
  return taskStatus(t.client, taskId);
}

// ---------- 技能库扫描与 skill 工具（单元） ----------

test("技能库：嵌套包、符号链接、缺描述、YAML 错误、同名冲突与超大 SKILL.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-skills-"));
  try {
    const lib = path.join(root, "agent", "skills");
    writeSkill(path.join(lib, "pack", "alpha"), "name: alpha\ndescription: ALPHA-DESC\nallowed-tools: bash", "ALPHA-BODY 见 refs/guide.md");
    writeSkill(path.join(lib, "pack", "nested", "beta"), "name: beta\ndescription: BETA-DESC\ndisable-model-invocation: true", "BETA-BODY");
    writeSkill(path.join(root, "outside", "gamma"), "name: gamma\ndescription: GAMMA-DESC", "GAMMA-BODY");
    fs.symlinkSync(path.join(root, "outside", "gamma"), path.join(lib, "linked"));
    writeSkill(path.join(lib, "nodesc"), "name: nodesc", "x");
    writeSkill(path.join(lib, "badyaml"), "name: [unclosed", "x");
    writeSkill(path.join(lib, "zdup"), "name: alpha\ndescription: DUP", "DUP-BODY");
    writeSkill(path.join(lib, "big"), "name: big\ndescription: BIG", "x".repeat(65 * 1024));

    const loaded = loadSkillLibrary(path.join(root, "agent"));
    assert.deepEqual(loaded.skills.map((s) => s.name).sort(), ["alpha", "beta", "gamma"]);
    assert.equal(loaded.skills.find((s) => s.name === "alpha")!.body, "ALPHA-BODY 见 refs/guide.md", "正文去掉 frontmatter");
    assert.equal(loaded.skills.find((s) => s.name === "beta")!.disableModelInvocation, true);
    const diag = loaded.diagnostics.join("\n");
    assert.match(diag, /nodesc.*description is required/);
    assert.match(diag, /badyaml/);
    assert.match(diag, /zdup.*alpha.*冲突/);
    assert.match(diag, /big.*64 KiB/);
    assert.match(loaded.version, /^sha256:[0-9a-f]{16}$/);

    // 技能库为空或不存在
    assert.deepEqual(loadSkillLibrary(path.join(root, "none")), { skills: [], diagnostics: [], version: "" });

    // skill 工具：正文、仅显式调用、未知名称
    assert.match(readSkill(loaded, "alpha"), /^\[技能 alpha · 版本 sha256:[0-9a-f]{16}[\s\S]*ALPHA-BODY/);
    assert.throws(() => readSkill(loaded, "beta"), /仅限拥有者显式调用/);
    assert.throws(() => readSkill(loaded, "nope"), /未知技能：nope.*alpha/);

    // 引用文件
    const alphaDir = path.join(lib, "pack", "alpha");
    fs.mkdirSync(path.join(alphaDir, "refs"));
    fs.writeFileSync(path.join(alphaDir, "refs", "guide.md"), "指南正文");
    fs.writeFileSync(path.join(alphaDir, "run.sh"), "#!/bin/sh\necho hi");
    fs.writeFileSync(path.join(alphaDir, "bin.dat"), Buffer.from([0x00, 0x01, 0xff, 0xfe]));
    fs.writeFileSync(path.join(alphaDir, "huge.md"), "y".repeat(64 * 1024 + 1));
    fs.writeFileSync(path.join(root, "secret.txt"), "SECRET");
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(alphaDir, "escape.txt"));
    const guide = readSkill(loaded, "alpha", "refs/guide.md");
    assert.ok(guide.includes("指南正文"));
    assert.ok(guide.includes(`sha256:${createHash("sha256").update("指南正文").digest("hex")}`), "带文件 sha256");
    assert.ok(readSkill(loaded, "alpha", "run.sh").includes("echo hi"), "脚本只作为文本返回");
    assert.throws(() => readSkill(loaded, "alpha", "../alpha/refs/guide.md"), /不含 \.\./);
    assert.throws(() => readSkill(loaded, "alpha", path.join(alphaDir, "refs", "guide.md")), /相对路径/);
    assert.throws(() => readSkill(loaded, "alpha", "escape.txt"), /越出技能目录/);
    assert.throws(() => readSkill(loaded, "alpha", "refs"), /不是普通文件/);
    assert.throws(() => readSkill(loaded, "alpha", "bin.dat"), /UTF-8|不是文本/);
    assert.throws(() => readSkill(loaded, "alpha", "huge.md"), /64 KiB/);
    assert.throws(() => readSkill(loaded, "alpha", "missing.md"), /不存在/);
    assert.throws(() => readSkill(loaded, "beta", "x.md"), /仅限拥有者显式调用/);

    // 显式调用：不受 disable-model-invocation 限制；未知名称列出可用技能
    const expanded = expandSkillCommand(loaded, "/skill:beta 参数一 参数二");
    assert.match(expanded, /^\[技能 beta · 版本 sha256:[0-9a-f]{16} · 拥有者显式调用[\s\S]*BETA-BODY\n\[\/技能 beta\]\n\n参数一 参数二$/);
    assert.equal(expandSkillCommand(loaded, "普通输入 /skill:beta"), "普通输入 /skill:beta");
    assert.throws(() => expandSkillCommand(loaded, "/skill:nope"), /未知技能：nope（可用技能：.*beta/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 集成 ----------

test("集成：main/coding 注入技能目录（无主机路径、无仅显式技能），chat 无目录无工具；/skills 可见诊断", async () => {
  const t = await startTestRuntime("skills-roles", async (req) => ({ kind: "text", text: `ok:${lastUserText(req).slice(0, 20)}` }));
  try {
    const lib = path.join(t.dirs.agentDir, "skills");
    writeSkill(path.join(lib, "alpha"), "name: alpha\ndescription: ALPHA-DESC", "ALPHA-BODY");
    writeSkill(path.join(lib, "beta"), "name: beta\ndescription: BETA-DESC\ndisable-model-invocation: true", "BETA-BODY");
    writeSkill(path.join(lib, "nodesc"), "name: nodesc", "x");

    const listed = await t.client.request<any>("list_skills");
    assert.deepEqual(listed.skills.map((s: any) => [s.name, s.explicitOnly]), [["alpha", false], ["beta", true]]);
    assert.ok(listed.diagnostics.some((d: string) => d.includes("nodesc")), "诊断经控制面可见");

    const orch = t.runtime.orchestrator!;
    await orch.registerInboundEvent({ source: "test", externalId: "chat-s", targetRole: "chat", body: "CHAT-SKILL-MARK" });
    const main = t.runtime.store.getAgentRole("main")!;
    const coding = t.runtime.store.getAgentRole("coding")!;
    const m = await t.runtime.submit({ sessionId: main.sessionId, requestId: "m-s", input: "MAIN-SKILL-MARK", modelSelection: t.runtime.defaultSelection });
    const c = await t.runtime.submit({ sessionId: coding.sessionId, requestId: "c-s", input: "CODING-SKILL-MARK", modelSelection: t.runtime.defaultSelection });
    await waitFor("main/coding 完成", () => ["completed"].includes(t.runtime.store.getTask(m.id)!.status) && t.runtime.store.getTask(c.id)!.status === "completed");
    await waitFor("chat 完成", () => t.runtime.store.getInboundEvent(t.runtime.store.findInboundEvent("test", "chat-s")!.id)!.status === "done");

    for (const mark of ["MAIN-SKILL-MARK", "CODING-SKILL-MARK"]) {
      const call = t.server.calls.find((x) => lastUserText(x).includes(mark))!;
      const text = JSON.stringify(call.messages);
      assert.ok(text.includes("[技能目录]") && text.includes("alpha：ALPHA-DESC"), `${mark} 含技能目录，块头不含版本`);
      const taskId = mark === "MAIN-SKILL-MARK" ? m.id : c.id;
      assert.match(t.runtime.listSelectionRecords({ taskId })[0]!.skillVersion ?? "", /^sha256:/, "选择记录照旧保存技能库版本");
      assert.ok(!text.includes("BETA-DESC"), "仅显式调用的技能不进目录");
      assert.ok(!text.includes(t.dirs.agentDir), "目录不含主机路径");
      assert.ok(toolNames(call).includes("skill"), `${mark} 有 skill 工具`);
    }
    const chatCall = t.server.calls.find((x) => lastUserText(x).includes("CHAT-SKILL-MARK"))!;
    assert.ok(!JSON.stringify(chatCall.messages).includes("技能目录"), "chat 无技能目录");
    assert.ok(!toolNames(chatCall).includes("skill"), "chat 无 skill 工具");
  } finally {
    await t.shutdown();
  }
});

test("集成：技能库为空时不注入目录，任务正常执行", async () => {
  const t = await startTestRuntime("skills-empty", async () => ({ kind: "text", text: "ok" }));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await submit(t, sessionId, "e1", "你好");
    assert.equal((await waitDone(t, task.id)).task.status, "completed");
    assert.ok(!JSON.stringify(t.server.calls[0]!.messages).includes("技能目录"));
    const records = await t.client.request<any>("list_selection_records", { task_id: task.id });
    assert.equal(records.records[0].skillVersion, "");
  } finally {
    await t.shutdown();
  }
});

test("集成：skill 加载完整正文（不截取、无审批），任务内钉版，下一任务生效；/context 有技能类别", async () => {
  let skillFile = "";
  const longBody = (tag: string) => `${tag}-HEAD ${"正文".repeat(3000)} ${tag}-TAIL`;
  const responder: Responder = async (req) => {
    const tool = lastToolContent(req);
    if (tool !== null) return { kind: "text", text: "读完了" };
    if (lastUserText(req).includes("加载技能")) {
      // 任务进行中修改 SKILL.md：本任务仍应拿到开始时的内容
      fs.writeFileSync(skillFile, `---\nname: alpha\ndescription: ALPHA-DESC\n---\n${longBody("NEW")}`);
      return { kind: "tool_calls", calls: [{ id: `s${Math.random().toString(36).slice(2, 6)}`, name: "skill", arguments: { name: "alpha" } }] };
    }
    return { kind: "text", text: "ok" };
  };
  const t = await startTestRuntime("skills-load", responder);
  try {
    skillFile = path.join(t.dirs.agentDir, "skills", "alpha", "SKILL.md");
    writeSkill(path.dirname(skillFile), "name: alpha\ndescription: ALPHA-DESC", longBody("OLD"));
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);

    for (const [i, mode] of (["confirm", "full_access", "auto-review"] as const).entries()) {
      const before = t.server.calls.length;
      const task = await submit(t, sessionId, `load-${i}`, `加载技能 ${i}`, { access_mode: mode });
      const status = await waitDone(t, task.id);
      assert.equal(status.task.status, "completed", `${mode} 下完成`);
      assert.equal(status.confirmations.length, 0, `${mode} 下加载技能不产生审批`);
      assert.equal(status.task.accessMode, mode, "权限模式不变");
      const content = t.server.calls.slice(before).map(lastToolContent).find((x) => x !== null)!;
      const tag = i === 0 ? "OLD" : "NEW";
      assert.ok(content.includes(`${tag}-HEAD`) && content.includes(`${tag}-TAIL`), `${mode}：结果完整（${tag}）`);
      assert.ok(!content.includes("中间省略"), "skill 结果不被截取");
      assert.match(content, /版本 sha256:[0-9a-f]{16}/);
    }

    const records = (await t.client.request<any>("list_selection_records", { session_id: sessionId, limit: 50 })).records as any[];
    const versions = new Set(records.map((r) => r.skillVersion));
    assert.equal(versions.size, 2, "第一任务后修改，下一任务版本随之变化");
    assert.ok(records.every((r) => r.cappedToolResults.length === 0));

    const breakdown = await t.client.request<any>("get_context_breakdown", { session_id: sessionId, record_id: records[0].id });
    const skills = breakdown.breakdown.categories.find((c: any) => c.key === "skills");
    assert.equal(skills.label, "技能");
    assert.ok(skills.tokens > 0);
  } finally {
    await t.shutdown();
  }
});

test("集成：/skill: 显式调用展开进入历史（含仅显式技能）；未知名称任务失败并列出可用技能", async () => {
  let skillFile = "";
  const t = await startTestRuntime("skills-explicit", async () => {
    // 任务进行中修改 SKILL.md：本任务的展开仍是开始时的内容
    fs.writeFileSync(skillFile, "---\nname: beta\ndescription: BETA-DESC\ndisable-model-invocation: true\n---\nBETA-NEW");
    return { kind: "text", text: "照做" };
  });
  try {
    skillFile = path.join(t.dirs.agentDir, "skills", "beta", "SKILL.md");
    writeSkill(path.dirname(skillFile), "name: beta\ndescription: BETA-DESC\ndisable-model-invocation: true", "BETA-BODY");
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await submit(t, sessionId, "x1", "/skill:beta 附加参数");
    assert.equal((await waitDone(t, task.id)).task.status, "completed");
    const user = lastUserText(t.server.calls[0]!);
    assert.match(user, /^\[技能 beta · 版本 sha256:[0-9a-f]{16} · 拥有者显式调用[\s\S]*BETA-BODY\n\[\/技能 beta\]\n\n附加参数$/);
    const sessionFile = t.runtime.store.getSession(sessionId)!.sessionFile!;
    assert.ok(fs.readFileSync(sessionFile, "utf8").includes("BETA-BODY"), "展开内容作为用户消息进入历史");

    const next = await submit(t, sessionId, "x1b", "/skill:beta");
    assert.equal((await waitDone(t, next.id)).task.status, "completed");
    assert.ok(lastUserText(t.server.calls[1]!).includes("BETA-NEW"), "下一任务展开新内容");

    const bad = await submit(t, sessionId, "x2", "/skill:nope");
    const status = await waitDone(t, bad.id);
    assert.equal(status.task.status, "failed");
    assert.match(status.task.errorMessage, /未知技能：nope（可用技能：beta）/);
    assert.equal(t.server.calls.length, 2, "未知技能不发模型请求");
  } finally {
    await t.shutdown();
  }
});

test("集成：技能目录超出预算按现有规则中断并暂停队列，不截断", async () => {
  const t = await startTestRuntime("skills-budget", async () => ({ kind: "text", text: "不应到达" }), { contextWindow: 60_000 });
  try {
    for (let i = 0; i < 150; i++) {
      writeSkill(path.join(t.dirs.agentDir, "skills", `s${i}`), `name: s${i}\ndescription: ${"d".repeat(1000)}`, "x");
    }
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await submit(t, sessionId, "b1", "你好");
    const status = await waitDone(t, task.id);
    assert.equal(status.task.status, "interrupted");
    assert.match(status.task.interruptReason, /context_budget_exceeded/);
    const skills = Number(/技能 (\d+)/.exec(status.task.interruptReason)?.[1]);
    assert.ok(skills > 40_000, `超预算来自技能目录（技能 ${skills}）`);
    assert.equal(t.server.calls.length, 0, "零 provider 请求");
    assert.equal((await t.client.request<any>("get_session", { session_id: sessionId })).queueState, "paused");
  } finally {
    await t.shutdown();
  }
});
