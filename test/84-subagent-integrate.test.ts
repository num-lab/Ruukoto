import { delegateFromActiveTask } from "./helpers/active-subagent-source.ts";
/**
 * 修改工作的改动汇总（agent-direction issue 17）：主 Agent 把 worktree 副本的
 * 改动汇入父工作区、冲突不覆盖、取消/关闭不改可汇总性。
 *
 * seam：Runtime 公共接口 + mock 模型 + 真实只读/写工具（realTools，local 后端）；
 * worker 命令在 local 后端真实执行 git，OS 边界另由原生 smoke 验证；一致性用
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
 *   旧 coding 角色会话的任务不能作为委派父任务；
 * - 边界：直接写入目标无副本（如实告知）、无差异为 empty、只读工作拒绝。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { test } from "node:test";
import { type Responder } from "./helpers/mock-provider.ts";
import {
  afterTool,
  lastUserText,
  realTools,
  startTestRuntime,
  waitFor,
} from "./helpers/testkit.ts";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import { controlledWorkCopy } from "./helpers/controlled-work-copy.ts";
import { holdParentResponse } from "./helpers/active-parent.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { completeCodingChild, seedCodingChild, seedCodingRole } from "./helpers/legacy-coding.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { subagentOpCheck } from "@ruukoto/agent/subagent-ledger.ts";
import { SubAgentDelegationError } from "@ruukoto/runtime/subagents.ts";

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
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("ig-multi", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    fs.writeFileSync(path.join(t.work[0]!, "src/b.ts"), "export const v = 2\n", "utf8");
    initGitRepo(t.work[0]!);
    const headBefore = gitOut(t.work[0]!, "rev-parse HEAD");
    const session = await rt.createSession({ projectName: "igm", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");

    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "ia", request: "PATCH-A 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d1-ia" });
    const b = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "ib", request: "PATCH-B 改 b 加新文件", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d1-ib" });
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
    parentGate.release();
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
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("ig-conflict", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igc", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "ic", request: "PATCH-CONF 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d2-ic" });
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
    parentGate.release();
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
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("ig-idem", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igi", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "ii", request: "PATCH-IDEM 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d3-ii" });
    await waitFor("子完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);

    const once = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(once.state, "applied");
    const twice = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(twice.state, "already", "重复汇总幂等（差异已在工作区）");
    assert.equal(integratedEvents(rt, a.work.id).length, 1, "幂等返回不重复登记");

    // 只读工作与无差异工作
    const ro = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "iro", request: "只读片段", readPaths: ["."], materials: null, paramsDigest: "d3-iro" });
    assert.rejects(
      () => rt.subagents!.integrate({ workId: ro.work.id, parentTaskId: parent.id, parentSessionId: session.id }),
      (e: any) => e.code === "invalid_state" || /只读/.test(String(e.message)),
    );
    const empty = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "ie", request: "NOOP 不改", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d3-ie" });
    await waitFor("空工作完工", () => rt.store.getTask(empty.task.id)!.resultSummary !== null);
    const re = await rt.subagents!.integrate({ workId: empty.work.id, parentTaskId: parent.id, parentSessionId: session.id });
    assert.equal(re.state, "empty");
    assert.equal(rt.store.hasIntegratedEvent(empty.work.id), false, "空差异不登记");
  } finally {
    parentGate.release();
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
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "id", request: "PATCH-DIR 写 docs", mode: "modify", target: "docs", materials: null, readPaths: null, paramsDigest: "d4-id" });
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
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("ig-salvage", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igs", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "is", request: "PATCH-SALV 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d5-is" });
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
    parentGate.release();
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
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("ig-reuse", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "igr", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");

    const oldWork = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "io", request: "PATCH-OLD 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d6-io" });
    await waitFor("旧工作完工", () => rt.store.getTask(oldWork.task.id)!.resultSummary !== null);
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(oldWork.agent.id)!.state === "idle");
    // 复用同一 Agent 承接新工作（另建副本），新工作改另一个文件
    const newWork = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "in", request: "PATCH-NEW 加文件", subAgentId: oldWork.agent.id, mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d6-in" });
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
    const busyWork = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "ibz", request: "PATCH-BUSY 挂起", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d6-ibz" });
    await waitFor("忙碌模型请求已挂起", () => release !== null);
    await assert.rejects(
      () => rt.subagents!.integrate({ workId: busyWork.work.id, parentTaskId: parent.id, parentSessionId: session.id }),
      (e: any) => e.code === "busy" || /活动任务/.test(String(e.message)),
    );
    release!();
    await waitFor("忙碌工作完工", () => rt.store.getTask(busyWork.task.id)!.resultSummary !== null);
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("main 经通用修改委派跑通（mode=modify + integrate）；旧 coding 角色会话的任务不能发起 modify", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("PATCH-MAIN")) {
      if (afterTool(req)) return { kind: "text", text: "child done" };
      return { kind: "tool_calls", calls: [{ id: "em", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 151" }] } }] };
    }
    return { kind: "text", text: "回复" };
  };
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("ig-main", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const mainCwd = rt.store.getSession(main.sessionId)!.cwdReal;
    // main 工作区放一份仓库
    fs.mkdirSync(path.join(mainCwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(mainCwd, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(mainCwd);
    const mparent = await rt.submit({ sessionId: main.sessionId, requestId: "pm", input: "开始（main）", modelSelection: rt.defaultSelection });
    await waitFor("main 父在运行", () => rt.store.getTask(mparent.id)!.status === "running");
    const m = await delegateFromActiveTask(rt, { parentTaskId: mparent.id, key: "im", request: "PATCH-MAIN 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d7-im" });
    assert.equal(m.work.writeTarget?.kind, "worktree", "main 的 Git 目标也走 worktree 副本");
    await waitFor("main 子完工", () => rt.store.getTask(m.task.id)!.resultSummary !== null);
    const rm = await rt.subagents!.integrate({ workId: m.work.id, parentTaskId: mparent.id, parentSessionId: main.sessionId });
    assert.equal(rm.state, "applied");
    assert.equal(fs.readFileSync(path.join(mainCwd, "src/a.ts"), "utf8"), "export const v = 151\n", "main 工作区经副本汇总完成修改");

    // 旧 coding 角色会话（issue 23 退役，只读归档）的任务不能作为 modify 的父任务
    const coding = seedCodingRole(rt.store, t.dirs.root);
    const cparent = seedCodingChild(rt.store, coding.sessionId, { key: "pc", mark: "旧任务" });
    completeCodingChild(rt.store, cparent.id, "旧结论", "{}");
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: cparent.id, key: "icd", request: "x", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "d7-icd" }),
      (error: unknown) => error instanceof SubAgentDelegationError && error.code === "forbidden",
    );
    assert.equal(rt.store.listWorkDelegationsBySession(coding.sessionId).length, 0);
    assert.equal(rt.store.listSubAgentsBySession(coding.sessionId).length, 0);
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

for (const phase of ["result_false", "result_throws", "ready", "call", "mode", "mode_call"] as const) {
  test(`汇总临时 worker ${phase} 停止未核实时保留双方成果和父目录占用`, async () => {
    const parentGate = holdParentResponse(async () => ({ kind: "text", text: "完成" }));
    const t = await startTestRuntime(`integrate-stop-${phase}`, parentGate.responder, { config: realTools(), workDirs: 1 });
    const hasResult = phase.startsWith("result_");
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const output = `RUUKOTO_STATE=applied\nRUUKOTO_HEAD=${hash}\nRUUKOTO_PATCH_BYTES=42\n1\t1\tsource.txt\n`;
    let stops = 0;
    const controlled = controlledWorkCopy(async () => {
      stops++;
      if (phase === "result_throws") throw new ExecutionError("injected_stop_failed", "模拟停止异常");
      return false;
    }, output, hasResult || (phase === "call" || phase === "mode_call"), false);
    try {
      const rt = t.runtime;
      const source = path.join(t.work[0], "source.txt");
      fs.writeFileSync(source, "source\n");
      initGitRepo(t.work[0]);
      const session = await rt.createSession({ projectName: "integrate-stop", cwd: t.work[0] });
      const parent = await rt.submit({ sessionId: session.id, requestId: "p", input: "开始", modelSelection: rt.defaultSelection });
      await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
      const delegation = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "create", request: "修改", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "create" });
      await waitFor("子任务结果已登记", () => rt.store.getTask(delegation.task.id)!.resultSummary !== null);
      const copy = delegation.work.writeTarget!;
      fs.writeFileSync(path.join(copy.path, "source.txt"), "成果\n");
      rt.launcherFor = () => controlled.launcher;
      const integration = rt.subagents!.integrate({ workId: delegation.work.id, parentTaskId: parent.id, parentSessionId: session.id });
      const rejected = assert.rejects(integration, { code: "worker_stop_unverified" });
      await waitFor("汇总单元已产生", () => (hasResult || (phase === "call" || phase === "mode_call")) ? controlled.requests.some((request) => request.type === "tool_call") : controlled.specs.length === 1);
      if (hasResult) {
        fs.writeFileSync(source, "成果\n");
        controlled.reply();
      } else if (phase.startsWith("mode")) {
        rt.store.withTx(() => rt.store.transitionTask(parent.id, ["running"], "awaiting_confirmation"));
        await assert.rejects(rt.switchTaskMode({ taskId: parent.id, mode: "full_access" }), { code: "mode_switch_unverified" });
      } else {
        await rt.cancelTask(parent.id);
      }
      await rejected;
      await waitFor("父任务终态", () => ["interrupted", "canceled"].includes(rt.store.getTask(parent.id)!.status));
      assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.taskId, parent.id);
      assert.equal(rt.store.getOccupancyByDir(copy.path)?.taskId, parent.id);
      assert.equal(fs.readFileSync(path.join(copy.path, "source.txt"), "utf8"), "成果\n");
      assert.equal(fs.readFileSync(source, "utf8"), hasResult ? "成果\n" : "source\n");
      assert.equal(integratedEvents(rt, delegation.work.id).length, 0);
      const op = rt.store.listToolOpsByTask(parent.id).find((entry) => entry.toolName === (hasResult || (phase === "call" || phase === "mode_call") ? "worktree_integrate" : "worktree_start"))!;
      if (hasResult) {
        assert.equal(op.resultSummary, output.trim());
        assert.equal(op.effectUnknown, false);
      } else {
        assert.equal(op.effectUnknown, (phase === "call" || phase === "mode_call"));
      }
      assert.equal(stops, 1);
      assert.equal(controlled.specs.length, 1);
      await assert.rejects(rt.subagents!.integrate({ workId: delegation.work.id, parentTaskId: parent.id, parentSessionId: session.id }), { code: "task_ending" });
      assert.equal(controlled.specs.length, 1);
      if (hasResult) {
        const nextParent = await rt.submit({ sessionId: session.id, requestId: "next-parent", input: "继续核实原成果", modelSelection: rt.defaultSelection });
        const continued = await delegateFromActiveTask(rt, { parentTaskId: nextParent.id, key: "continue-blocked", request: "继续原成果", workId: delegation.work.id, materials: null, readPaths: null, paramsDigest: "continue-blocked" });
        const copySession = await rt.createSession({ projectName: "integrate-copy-blocked", cwd: copy.path });
        const copyTask = await rt.submit({ sessionId: copySession.id, requestId: "copy-blocked", input: "副本独立任务", modelSelection: rt.defaultSelection });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(rt.store.getTask(continued.task.id)!.status, "queued");
        assert.equal(rt.store.getTask(copyTask.id)!.status, "queued");
        await rt.resumeQueue(session.id);
        await waitFor("副本执行队列恢复", () => rt.store.getTask(continued.task.id)!.status === "completed" && rt.store.getTask(copyTask.id)!.status === "completed");
        assert.equal(rt.store.getOccupancyByDir(session.cwdReal), null);
        assert.equal(rt.store.getOccupancyByDir(copy.path), null);
        assert.equal(controlled.specs.length, 1);
      }
    } finally {
      parentGate.release();
      controlled.finish();
      await t.shutdown();
    }
  });
}
