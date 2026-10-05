/**
 * 修改工作的改动汇总（agent-direction issue 17）：主 Agent 把 worktree 副本的
 * 改动汇入父工作区、冲突不覆盖、取消/关闭不改可汇总性。
 *
 * seam：Runtime 公共接口 + mock 模型 + 真实只读/写工具（realTools，local 后端）；
 * 容器命令在 local 后端真实执行 git（路径与边界语义与冒烟一致）；一致性用
 * store/文件字节/TUI 提示三处断言。
 *
 * 覆盖整单验收：
 * - 多个执行副本汇入主工作区：字节精确、不动父 HEAD、保留父未提交改动，
 *   结果经 work_delegation.integrated 事件关联原工作（来源 = 工作 + 基线提交）；
 * - 冲突：父工作区原改动与副本成果双方保留、不强制覆盖、零写入、报冲突文件；
 * - 取消工作/关闭 SubAgent 后仍可汇总（副本与成果保留）；幂等重汇总不重复登记；
 * - 汇总前核实副本与原工作区状态：副本被替换/删除明确拒绝；忙碌拒绝；
 *   Agent 复用承接新工作后，按工作 id 汇总的仍只是该工作的产出；
 * - main 的修改委派转通用链路（mode=modify + subagent_integrate）跑通；
 *   固定 coding 角色会话仍拒绝 modify；
 * - 边界：直接写入目标无副本（如实告知）、无差异为 empty、只读工作拒绝。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { test } from "node:test";
import { type Responder, type RecordedRequest } from "./helpers/mock-provider.ts";
import {
  lastUserText,
  realTools,
  startTestRuntime,
  waitFor,
} from "./helpers/testkit.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { ViewState } from "../src/tui/state.ts";
import { subagentOpCheck } from "../src/runtime/subagents.ts";

/** 本轮请求的最后一条是工具结果（模型拿到工具返回后的下一次调用）。 */
function afterTool(req: RecordedRequest): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
}

const gitOut = (cwd: string, args: string): string =>
  childProcess.execFileSync("git", args.split(" "), { cwd, encoding: "utf8" }).trim();

/** 本会话名下登记的 integrated 事件（原始 SQL 查事件体）。 */
function integratedEvents(rt: any, workId: string): Array<Record<string, any>> {
  return (rt.store.db
    .prepare("SELECT body FROM events WHERE json_extract(body, '$.type') = 'work_delegation.integrated' AND json_extract(body, '$.workId') = ? ORDER BY seq")
    .all(workId) as Array<{ body: string }>).map((r) => JSON.parse(r.body));
}

test("多副本汇总：两项修改工作的副本改动经 integrate 汇入父工作区，不动 HEAD、保留父未提交改动、事件关联原工作", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]")) {
      if (afterTool(req)) return { kind: "text", text: "child done" };
      if (text.includes("PATCH-A"))
        return { kind: "tool_calls", calls: [{ id: "ea", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 101" }] } }] };
      if (text.includes("PATCH-B"))
        return { kind: "tool_calls", calls: [
          { id: "eb", name: "edit", arguments: { path: "src/b.ts", edits: [{ oldText: "export const v = 2", newText: "export const v = 202" }] } },
          { id: "eb2", name: "write", arguments: { path: "src/new.md", content: "from copy B\n" } },
        ] };
      return { kind: "text", text: "child done" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("ig-multi", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    fs.writeFileSync(path.join(t.work[0]!, "src/b.ts"), "export const v = 2\n", "utf8");
    initGitRepo(t.work[0]!);
    const headBefore = gitOut(t.work[0]!, "rev-parse HEAD");
    const session = await rt.createSession({ projectName: "igm", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "ia", request: "PATCH-A 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d1-ia" });
    const b = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "ib", request: "PATCH-B 改 b 加新文件", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d1-ib" });
    await waitFor("A 完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitFor("B 完工", () => rt.store.getTask(b.task.id)!.resultSummary !== null);
    const wtA = a.work.writeTarget!;
    const wtB = b.work.writeTarget!;
    assert.ok(wtA.kind === "worktree" && wtB.kind === "worktree");
    // 汇总前父工作区字节照原；父的未提交新增在汇总前后都不被触碰
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 1\n");
    fs.writeFileSync(path.join(t.work[0]!, "local-note.txt"), "mine\n", "utf8");

    const ra = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    const rb = await rt.subagents!.integrate({ workId: b.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(ra.state, "applied");
    assert.equal(rb.state, "applied");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 101\n");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/b.ts"), "utf8"), "export const v = 202\n");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/new.md"), "utf8"), "from copy B\n");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "local-note.txt"), "utf8"), "mine\n", "父未提交新增不被汇总触碰");
    // 不代提交：父 HEAD 不变
    assert.equal(gitOut(t.work[0]!, "rev-parse HEAD"), headBefore);
    // 副本一律保留（仍能作为成品找回）
    assert.equal(fs.readFileSync(path.join(wtA.path, "src/a.ts"), "utf8"), "export const v = 101\n");
    assert.equal(fs.readFileSync(path.join(wtB.path, "src/new.md"), "utf8"), "from copy B\n");
    // 关联原工作：每次汇总一条事件，带来源与统计
    const evA = integratedEvents(rt, a.work.id);
    const evB = integratedEvents(rt, b.work.id);
    assert.equal(evA.length, 1);
    assert.equal(evA[0]!.workId, a.work.id);
    assert.equal(evA[0]!.subAgentId, a.agent.id);
    assert.equal(evA[0]!.baseCommit, wtA.baseCommit, "来源基线钉定");
    assert.equal(evA[0]!.taskId, parent.id, "来源发起任务（汇总者的执行）");
    assert.equal(evA[0]!.parentHead, headBefore, "汇总时父 HEAD 如实记录");
    assert.deepEqual(evA[0]!.files, ["src/a.ts"]);
    assert.equal(evB.length, 1);
    assert.deepEqual(evB[0]!.files.sort(), ["src/b.ts", "src/new.md"]);
    assert.equal(rt.store.hasIntegratedEvent(a.work.id), true);
    assert.equal(rt.store.hasIntegratedEvent(b.work.id), true);
  } finally {
    await t.shutdown();
  }
});

test("冲突：父工作区同文件已有本地改动 → 拒绝强制覆盖、双方成果保留、零写入、报冲突文件", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("PATCH-CONF")) {
      if (afterTool(req)) return { kind: "text", text: "child done" };
      return { kind: "tool_calls", calls: [{ id: "ec", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 111" }] } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("ig-conflict", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igc", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "ic", request: "PATCH-CONF 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d2-ic" });
    await waitFor("子完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    const wt = a.work.writeTarget!;
    // 父在同一路径留下本地改动（与副本改动同上下文）
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1 // 拥有者本地\n", "utf8");

    await assert.rejects(
      () => rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id }),
      (e: any) => {
        assert.equal(e.code, "integrate_conflict");
        assert.match(e.message, /src\/a\.ts/, "错误点名冲突文件");
        assert.match(e.message, /保留/, "错误说明双方保留");
        return true;
      },
    );
    // 零写入：父本地原改动与副本成果都在
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 1 // 拥有者本地\n", "父原改动不覆盖");
    assert.equal(fs.readFileSync(path.join(wt.path, "src/a.ts"), "utf8"), "export const v = 111\n", "副本成果保留");
    assert.equal(rt.store.hasIntegratedEvent(a.work.id), false, "冲突不登记汇总事件");
  } finally {
    await t.shutdown();
  }
});

test("幂等与空差异：套用后重复汇总为 already 不重复登记；无差异为 empty", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("PATCH-IDEM")) {
      if (afterTool(req)) return { kind: "text", text: "child done" };
      return { kind: "tool_calls", calls: [{ id: "ei", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 121" }] } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("ig-idem", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igi", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "ii", request: "PATCH-IDEM 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d3-ii" });
    await waitFor("子完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);

    const once = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(once.state, "applied");
    const twice = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(twice.state, "already", "重复汇总幂等（差异已在工作区）");
    assert.equal(integratedEvents(rt, a.work.id).length, 1, "幂等返回不重复登记");

    // 只读工作与无差异工作
    const ro = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "iro", request: "只读片段", readPaths: ["."], materials: null, paramsDigest: "d3-iro" });
    assert.rejects(
      () => rt.subagents!.integrate({ workId: ro.work.id, parentTaskId: parent.id, parentSessionId: session.id }),
      (e: any) => e.code === "invalid_state" || /只读/.test(String(e.message)),
    );
    const empty = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "ie", request: "NOOP 不改", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d3-ie" });
    await waitFor("空工作完工", () => rt.store.getTask(empty.task.id)!.resultSummary !== null);
    const re = await rt.subagents!.integrate({ workId: empty.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(re.state, "empty");
    assert.equal(rt.store.hasIntegratedEvent(empty.work.id), false, "空差异不登记");
  } finally {
    await t.shutdown();
  }
});

test("直接写入目标：integrate 如实告知无副本需要汇总，无事件零写入", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("PATCH-DIR")) {
      if (afterTool(req)) return { kind: "text", text: "child done" };
      return { kind: "tool_calls", calls: [{ id: "ed", name: "write", arguments: { path: "notes.md", content: "direct\n" } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("ig-direct", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "docs"), { recursive: true });
    const session = await rt.createSession({ projectName: "igd", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "id", request: "PATCH-DIR 写 docs", mode: "modify", target: "docs", materials: null, readPaths: null, paramsDigest: "d4-id" });
    assert.equal(a.work.writeTarget?.kind, "direct", "非 Git 目标是直接写入");
    await waitFor("子完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    const r = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(r.state, "direct");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "docs/notes.md"), "utf8"), "direct\n", "直接写入本就落在父工作区");
    assert.equal(rt.store.hasIntegratedEvent(a.work.id), false, "直接写入不登记汇总事件");
  } finally {
    await t.shutdown();
  }
});

test("取消工作与关闭 SubAgent 不拦汇总：取消（owner）+ 关闭（owner）后 integrate 成功、TUI 提示与账本核实到位", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("PATCH-SALV")) {
      if (afterTool(req)) return { kind: "text", text: "child done" };
      return { kind: "tool_calls", calls: [{ id: "es", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 131" }] } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("ig-salvage", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igs", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "is", request: "PATCH-SALV 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d5-is" });
    await waitFor("子完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    // 取消整项工作 + 关闭 SubAgent：成果仍应找回（未汇总的修改不被取消/关闭删除）
    await rt.subagents!.cancelWork({ workId: a.work.id, by: "owner" });
    rt.subagents!.close({ subAgentId: a.agent.id, by: "owner" });
    assert.equal(rt.store.getSubAgent(a.agent.id)!.closedAt !== null, true);

    const r = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(r.state, "applied", "取消与关闭后仍可汇总副本成果");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 131\n");

    // TUI 提示（未打开会话视图时进全局提示）
    const state = new ViewState();
    state.applyEvent(
      {
        seq: 1, taskId: parent.id, sessionId: session.id, createdAt: new Date().toISOString(),
        body: (integratedEvents(rt, a.work.id)[0] as any),
      },
      "live",
    );
    assert.ok(state.globalNotes.some((n) => n.text.includes("已汇总")), "TUI 提示改动已汇总");

    // 工具操作账本的族核实：integrated → committed
    const check = subagentOpCheck(rt.store);
    assert.equal(check.verify({ taskId: parent.id, toolName: "subagent_integrate", params: { work_id: a.work.id } }), "committed");
    assert.equal(check.verify({ taskId: parent.id, toolName: "subagent_integrate", params: { work_id: "work_none" } }), "unverifiable");
  } finally {
    await t.shutdown();
  }
});

test("复用隔离与状态核实：按工作 id 汇总的只是该工作产出；副本被替换拒绝；有活动任务拒绝（busy）", async () => {
  let release: (() => void) | null = null;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]")) {
      if (text.includes("PATCH-BUSY")) {
        await new Promise<void>((res) => (release = res));
        return { kind: "text", text: "busy done" };
      }
      if (afterTool(req)) return { kind: "text", text: "child done" };
      if (text.includes("PATCH-OLD")) return { kind: "tool_calls", calls: [{ id: "eo", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 141" }] } }] };
      if (text.includes("PATCH-NEW")) return { kind: "tool_calls", calls: [{ id: "en", name: "write", arguments: { path: "src/another.md", content: "new work\n" } }] };
      return { kind: "text", text: "child done" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("ig-reuse", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igr", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    const oldWork = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "io", request: "PATCH-OLD 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d6-io" });
    await waitFor("旧工作完工", () => rt.store.getTask(oldWork.task.id)!.resultSummary !== null);
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(oldWork.agent.id)!.state === "idle");
    // 复用同一 Agent 承接新工作（另建副本），新工作改另一个文件
    const newWork = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "in", request: "PATCH-NEW 加文件", subAgentId: oldWork.agent.id, mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d6-in" });
    await waitFor("新工作完工", () => rt.store.getTask(newWork.task.id)!.resultSummary !== null);
    assert.notEqual(newWork.work.writeTarget!.path, oldWork.work.writeTarget!.path);

    // 汇总旧工作：只带旧工作的改动
    const rOld = await rt.subagents!.integrate({ workId: oldWork.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(rOld.state, "applied");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 141\n");
    assert.equal(fs.existsSync(path.join(t.work[0]!, "src/another.md")), false, "旧工作汇总不带出新工作的改动");
    assert.deepEqual((integratedEvents(rt, oldWork.work.id)[0] as any).files, ["src/a.ts"], "事件文件清单只列旧工作产出");

    // 副本被替换/删除后明确拒绝（不自动重建、不凭旧记录套用）
    fs.rmSync(oldWork.work.writeTarget!.path, { recursive: true, force: true });
    await assert.rejects(
      () => rt.subagents!.integrate({ workId: oldWork.work.id, parentTaskId: parent.id, parentSessionId: session.id }),
      (e: any) => e.code === "worktree_gone",
    );

    // 忙碌拒绝：新工作的另一次执行在跑（持有副本）
    const busyWork = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "ibz", request: "PATCH-BUSY 挂起", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d6-ibz" });
    await waitFor("忙碌任务在跑", () => release !== null || rt.store.getTask(busyWork.task.id)!.status === "running");
    await assert.rejects(
      () => rt.subagents!.integrate({ workId: busyWork.work.id, parentTaskId: parent.id, parentSessionId: session.id }),
      (e: any) => e.code === "busy" || /活动任务/.test(String(e.message)),
    );
    release!();
    await waitFor("忙碌工作完工", () => rt.store.getTask(busyWork.task.id)!.resultSummary !== null);
  } finally {
    await t.shutdown();
  }
});

test("main 经通用修改委派跑通（mode=modify + integrate）；固定 coding 角色会话仍拒绝 modify", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("PATCH-MAIN")) {
      if (afterTool(req)) return { kind: "text", text: "child done" };
      return { kind: "tool_calls", calls: [{ id: "em", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 151" }] } }] };
    }
    return { kind: "text", text: "回复" };
  };
  const t = await startTestRuntime("ig-main", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const mainCwd = rt.store.getSession(main.sessionId)!.cwdReal;
    // main 工作区放一份仓库
    fs.mkdirSync(path.join(mainCwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(mainCwd, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(mainCwd);
    const mparent = await rt.submit({ sessionId: main.sessionId, requestId: "pm", input: "开始（main）", modelSelection: rt.defaultSelection });
    await waitFor("main 父完成", () => rt.store.getTask(mparent.id)!.status === "completed");
    const m = await rt.subagents!.delegate({ parentTaskId: mparent.id, key: "im", request: "PATCH-MAIN 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d7-im" });
    assert.equal(m.work.writeTarget?.kind, "worktree", "main 的 Git 目标也走 worktree 副本");
    await waitFor("main 子完工", () => rt.store.getTask(m.task.id)!.resultSummary !== null);
    const rm = await rt.subagents!.integrate({ workId: m.work.id, parentTaskId: mparent.id, parentSessionId: main.sessionId });
    assert.equal(rm.state, "applied");
    assert.equal(fs.readFileSync(path.join(mainCwd, "src/a.ts"), "utf8"), "export const v = 151\n", "main 工作区经副本汇总完成修改");

    // 固定 coding 角色会话仍不能发起 modify（旧入口仅迁移期兼容，不经通用链路登记）
    const cparent = await rt.submit({ sessionId: coding.sessionId, requestId: "pc", input: "开始（coding）", modelSelection: rt.defaultSelection });
    await waitFor("coding 父完成", () => rt.store.getTask(cparent.id)!.status === "completed");
    await assert.rejects(
      () => rt.subagents!.delegate({ parentTaskId: cparent.id, key: "icd", request: "x", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d7-icd" }),
      /只有普通开发会话或 main|固定角色/,
    );
  } finally {
    await t.shutdown();
  }
});
