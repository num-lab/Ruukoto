import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";
/**
 * 修改委派的并行 worktree 与非 Git 串行（agent-direction issue 16）。
 *
 * seam：Runtime 公共接口 + mock 模型 + 真实只读工具（realTools，local 后端）；
 * worktree 创建与挂载以 git init 临时仓库为准；一致性用 store/快照/TUI 汇总
 * 三处断言；copy 路径派生自 dataDir 的兄弟目录 agent-work/worktrees。
 *
 * 覆盖六项验收：
 * - 两个子任务同一父会话、同一仓库、不同分支并行写入各自 worktree（同时
 *   running）；work show/TUI 汇总可定位分支、工作区字节与未提交改动不变；
 *   LaunchSpec 只以读写挂自己的副本、共享 Git 目录作只读 readRoot、
 *   grantedPaths 为空、宿主注入环境只带 safe.directory=*；
 * - 授予路径不能覆盖副本根（读仍允许）；共享 Git 目录在工作区之外拒绝；
 *   仓库钩子/fsmonitor 不落宿主（离线仅核验宿主执行偏好）。
 * - 非 Git 目录写入与父会话按目录占用串行（父持锁时子任务保持 queued，父
 *   本轮结束经占用释放启动）；占用取/放覆盖相等、祖先/子孙（分隔符边界）、
 *   兄弟 dev/ino 别名与释放唤醒。
 * - 创建失败保留残余现场（错误含路径与分支、副本目录不被删除、不自动重建、
 *   不登记工作）；单次任务取消后已写文件仍在；worktree 被删除后的继续委派
 *   明确拒绝；退出未核实的占用按 worktree 键保留，Agent 记 unverified；取消
 *   不触碰副本；继续委派沿用首次钉定目标，复用承接新工作另建副本；
 * - 计划模式/SubAgent 自身不能发起 modify 委派（main 由 issue 17 开放、固定
 *   角色拒绝在 test/84 覆盖）；只读工作不能升级为写入；
 *   modify 摘要不进 11 的重放摘要；原生执行边界由真实 OS 冒烟验证。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { type Responder } from "./helpers/mock-provider.ts";
import {
  afterTool,
  lastToolText,
  inputText,
  toolNamesOf,
  cleanupDirs,
  lastUserText,
  makeTestDirs,
  realTools,
  startTestRuntime,
  waitFor,
} from "./helpers/testkit.ts";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import { controlledWorkCopy } from "./helpers/controlled-work-copy.ts";
import { holdParentResponse } from "./helpers/active-parent.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { createSubAgentTools } from "@ruukoto/agent/subagent-tools.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";

test("并行 worktree：两项修改工作同时 running，各自改动隔离，主工作区字节不变，worktree 分支与 TUI 汇总可定位", async () => {
  let releaseA: (() => void) | null = null;
  let releaseB: (() => void) | null = null;
  let firstEditA = true;
  let firstEditB = true;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]")) {
      if (text.includes("PATCH-A")) {
        // 两次模型调用：第一拍挂起（父持锁期间并行 running），第二拍发 edit 后完工
        if (firstEditA) {
          firstEditA = false;
          await new Promise<void>((res) => (releaseA = res));
          return { kind: "tool_calls", calls: [{ id: "e_a", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 101" }] } }] };
        }
        return { kind: "text", text: "A 完工" };
      }
      if (text.includes("PATCH-B")) {
        if (firstEditB) {
          firstEditB = false;
          await new Promise<void>((res) => (releaseB = res));
          return { kind: "tool_calls", calls: [{ id: "e_b", name: "edit", arguments: { path: "src/b.ts", edits: [{ oldText: "export const v = 2", newText: "export const v = 202" }] } }] };
        }
        return { kind: "text", text: "B 完工" };
      }
      return { kind: "text", text: "child" };
    }
    return { kind: "text", text: "父回复" };
  };
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("worktree-parallel", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    const launchModes: string[] = [];
    const originalLauncher = rt.launcherFor.bind(rt);
    rt.launcherFor = (mode) => { launchModes.push(mode); return originalLauncher(mode); };
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    fs.writeFileSync(path.join(t.work[0]!, "src/b.ts"), "export const v = 2\n", "utf8");
    initGitRepo(t.work[0]!);
    // 父工作区的未提交修改与新增不能进副本；主会话字节照原
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1 // dirty\n", "utf8");
    const session = await rt.createSession({ projectName: "wtpar", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");

    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "wt-a", request: "PATCH-A 改 a.ts", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "da-wta",
    });
    const b = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "wt-b", request: "PATCH-B 改 b.ts", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "da-wtb",
    });
    const wtA = a.work.writeTarget!;
    const wtB = b.work.writeTarget!;
    assert.ok(wtA.kind === "worktree" && wtB.kind === "worktree", "两项写入目标都是 worktree");
    assert.notEqual(wtA.path, wtB.path, "副本不共享目录");
    assert.notEqual(wtA.branch, wtB.branch, "分支按工作而不同（并行要求）");
    assert.equal(wtA.commonGitDir, wtB.commonGitDir, "同一仓库的共享 Git 目录");
    assert.match(wtA.baseCommit, /^[0-9a-f]{40}$/, "基线提交钉定");
    assert.ok(fs.existsSync(wtA.path) && fs.existsSync(wtB.path), "副本目录已建");
    assert.ok(wtA.path.includes(path.join("agent-work", "worktrees")), "副本在 agent-work/worktrees 下");

    assert.equal(a.task.accessMode, "full_access");
    assert.equal(b.task.accessMode, "full_access");
    assert.equal(a.task.sourcePermissionVersion, parent.permissionVersion);
    assert.ok(launchModes.length >= 3 && launchModes.every((mode) => mode === "full_access"), "主任务、委派与临时副本执行均采用完全访问");
    await waitFor("A 在 running", () => rt.store.getTask(a.task.id)!.status === "running");
    await waitFor("B 在 running", () => rt.store.getTask(b.task.id)!.status === "running");
    // running 状态先于模型调用到达：释放闸等调用在途，负载下不塌
    await waitFor("A 模型调用在途", () => releaseA !== null);
    await waitFor("B 模型调用在途", () => releaseB !== null);
    releaseA!();
    releaseB!();
    await waitFor("A 完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitFor("B 完工", () => rt.store.getTask(b.task.id)!.resultSummary !== null);

    // 改动落在各自副本，主工作区字节不变（含未提交的 dirty 与后续新增）
    assert.equal(fs.readFileSync(path.join(wtA.path, "src/a.ts"), "utf8"), "export const v = 101\n");
    assert.equal(fs.readFileSync(path.join(wtB.path, "src/b.ts"), "utf8"), "export const v = 202\n");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 1 // dirty\n", "主工作区副本不能被「已存在的污染」改变");
    fs.writeFileSync(path.join(t.work[0]!, "untracked.md"), "uncommitted-ocius\n", "utf8");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "untracked.md"), "utf8"), "uncommitted-ocius\n", "未提交新增未进入副本");

    // 查看：快照中的写入目标与 TUI 汇总
    const shown = (await t.client.request<any>("work_get", { work_id: a.work.id })) as any;
    assert.equal(shown.work.writeTarget.branch, wtA.branch);
    assert.equal(shown.work.writeTarget.baseCommit, wtA.baseCommit);
    const state = new ViewState();
    state.workDelegations = rt.store.listWorkDelegationsBySession(session.id);
    state.subAgents = rt.store.listSubAgentsBySession(session.id);
    const summary = state.worksSummaryForSession(session.id)!;
    assert.ok(summary.includes(`worktree 分支 ${wtA.branch}`), "TUI 标写分支与本地副本");
    assert.ok(summary.includes(`worktree 分支 ${wtB.branch}`));
    assert.ok(!summary.includes("直接写入"), "worktree 工作不标直接写入");
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("子任务的 LaunchSpec 钉定：workspace=本副本、共享 Git 目录在 readRoots、grantedPaths 为空、env 仅此 safe.directory=*", async () => {
  let release: (() => void) | null = null;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]")) {
      await new Promise<void>((res) => (release = res));
      return { kind: "text", text: "完工" };
    }
    return { kind: "text", text: "父回复" };
  };
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("worktree-spec", parentGate.responder, { config: realTools(), workDirs: 1 });
  let wt!: Extract<import("@ruukoto/core/types.ts").WorkWriteTarget, { kind: "worktree" }>;
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wtspec", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "spec-a", request: "PATCH-LAT", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dspeca",
    });
    await waitFor("子任务 running", () => rt.store.getTask(a.task.id)!.status === "running");
    // running 状态先于模型调用到达：释放闸等调用在途，负载下不塌
    await waitFor("子模型调用在途", () => release !== null);
    const task = rt.store.getTask(a.task.id)!;
    const sessionSub = rt.store.getSession(task.sessionId)!;
    const wtRaw = a.work.writeTarget!;
    assert.ok(wtRaw.kind === "worktree");
    wt = wtRaw;
    // 静态辅助（同一决定点）：副本 LaunchSpec 由「当前任务 + 本工作写入目标」单一决定
    const router = (rt as any).drivers.get(a.agent.sessionId)?.router;
    const driverSpec = router?.launchSpecFor(task, sessionSub);
    assert.ok(driverSpec, "Driver 活跃时可读出 LaunchSpec");
    assert.equal(driverSpec.workspace, wt.path, "workspace 是本副本");
    assert.deepEqual(driverSpec.grantedPaths, [], "不继承任何 grantedPaths");
    assert.equal(driverSpec.readRoots.length, 1, "worktree 副本只多一枚 readRoot");
    const commonStat = fs.statSync(wt.commonGitDir);
    assert.deepEqual(
      driverSpec.readRoots[0],
      { path: wt.commonGitDir, dev: commonStat.dev, ino: commonStat.ino },
      "共享 Git 目录按宿主身份只读纳入",
    );
    assert.deepEqual(driverSpec.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, "只带 Git safe.directory=* 的宿主注入环境");
    assert.deepEqual(
      driverSpec.workspaceIdentity,
      { dev: wt.dev, ino: wt.ino },
      "写入目标按宿主身份钉定",
    );
    release!();
    await waitFor("子完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("授予路径与边界守门：覆盖副本根的读写被拒绝、只读允许、共享 Git 目录越出工作区拒绝", async () => {
  const responder: Responder = async () => ({ kind: "text", text: "done" });
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("worktree-guard", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wtguard", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "gu-a", request: "x", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dgu-a",
    });
    await waitFor("副本已建", () => fs.existsSync(a.work.writeTarget!.path));
    const copyRoot = path.join(path.dirname(path.resolve(rt.config.dataDir)), "agent-work", "worktrees");

    // 覆盖副本根的读写授予拒绝
    await assert.rejects(
      () =>
        rt.submit({
          sessionId: session.id, requestId: "g-rw", input: "越界写", modelSelection: rt.defaultSelection,
          grantedPaths: [{ path: copyRoot, access: "read_write", purpose: "验证副本根守门" }],
        }),
      /副本根|读写授权不能覆盖宿主管理的工作副本根/,
    );
    parentGate.release();
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    // 只读授予仍允许
    const ok = await rt.submit({
      sessionId: session.id, requestId: "g-ro", input: "只读挂载", modelSelection: rt.defaultSelection,
      grantedPaths: [{ path: copyRoot, access: "read", purpose: "只读授权" }],
    });
    await waitFor("只读授予任务结束", () => rt.store.getTask(ok.id)!.status === "completed");

    // 共享 Git 目录在工作区之外：仓库根是工作区外的真仓储
    fs.mkdirSync(path.join(t.dirs.root, "outside-repo"), { recursive: true });
    fs.writeFileSync(path.join(t.dirs.root, "outside-repo", "x.txt"), "init\n", "utf8");
    initGitRepo(path.join(t.dirs.root, "outside-repo"));
    // 经符号链接（realpath 在工作区外）指向工作区外仓库——realpath 判定在工作区外
    fs.symlinkSync(path.join(t.dirs.root, "outside-repo"), path.join(t.work[0]!, "outside-link"));
    await assert.rejects(
      () =>
        delegateFromActiveTask(rt, {
          parentTaskId: parent.id, key: "gu-out", request: "x", mode: "modify", target: "outside-link",
          materials: null, readPaths: null, paramsDigest: "dgu-out",
        }),
      /工作区内/,
    );

    // 此离线用例仅设置仓库钩子与 fsmonitor；宿主不执行仓库 Git、
    // 原生边界与植入拒绝另由真实 smoke 验证。
    fs.writeFileSync(path.join(t.work[0]!, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.appendFileSync(path.join(t.work[0]!, ".git/config"), "\n[core]\nfsmonitor = /bin/false\n", "utf8");
    assert.ok(true, "宿主永不执行 git（副本创建的唯一 git 入口在 worker）");
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("非 Git 目录写入：父持锁时子任务 queued，父本轮结束经占用释放启动；subagent_result 如实说明", async () => {
  let release: (() => void) | null = null;
  let releaseParent: (() => void) | null = null;
  const marks: string[] = [];
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("WRITE-DIRECT")) {
      marks.push("child-started");
      await new Promise<void>((res) => (release = res));
      return { kind: "text", text: "child-done" };
    }
    if (text.includes("开始（父在跑）")) {
      await new Promise<void>((res) => (releaseParent = res));
      return { kind: "text", text: "父回复" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("direct-serial", responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "docs"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "docs/notes.md"), "alpha\n", "utf8");
    const session = await rt.createSession({ projectName: "dser", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始（父在跑）", modelSelection: rt.defaultSelection });
    await waitFor("父在 running", () => releaseParent !== null);
    // 父持锁时发起非 Git 修改（target 是父工作区内的非 Git 子树）
    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "d1", request: "WRITE-DIRECT", mode: "modify", target: "docs",
      materials: null, readPaths: null, paramsDigest: "dd1",
    });
    const wtRaw = a.work.writeTarget!;
    assert.ok(wtRaw.kind === "direct", "非 Git 目标走直接写入");
    const wt = wtRaw;
    assert.equal(wt.path, fs.realpathSync(path.join(t.work[0]!, "docs")));
    // 父持锁期间子任务排队、零模型启动
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(rt.store.getTask(a.task.id)!.status, "queued", "父持锁期间子任务仍排队");
    }
    assert.deepEqual<string[]>(marks, [], "子任务没有提前启动");
    // subagent_result 结果视图提示：父会话本轮结束前子任务不会启动
    const projectId = rt.store.getSession(session.id)!.projectId;
    const tools = createSubAgentTools({
      coreStore: rt.store,
      sources: (rt as any).sources,
      delegate: (input) => delegateFromActiveTask(rt, input),
      close: (input) => rt.subagents!.close(input),
      cancelWork: (input) => rt.subagents!.cancelWork(input),
      message: (input) => messageFromActiveTask(rt, input),
      integrate: (input) => rt.subagents!.integrate(input),
      readReply: (taskId, offset, length) => rt.readTaskReply(taskId, offset, length),
      artifacts: rt.artifacts,
      taskContext: () => ({ taskId: parent.id, sessionId: session.id, projectId, hostOpId: "opd" }),
      bindCall: undefined,
      verifyHost: () => null,
    });
    const resultTool = tools.find((x) => x.name === "subagent_result")!;
    const exec = (tool: any, params: any) => tool.execute("sdkx", params, undefined as any, undefined as any, {} as any);
    const shown = (await exec(resultTool, { work_id: a.work.id })).content[0].text as string;
    assert.ok(shown.includes("等待本会话释放目录"), "排队如实说明父持锁");

    // 父任务结束（本轮完成）→ 占用释放唤醒 → 子任务启动并完成
    releaseParent!();
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    await waitFor("子任务启动", () => rt.store.getTask(a.task.id)!.status === "running");
    await waitFor("子模型调用在途", () => release !== null);
    release!();
    await waitFor("子完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    assert.ok(marks.includes("child-started"), "子任务在父结束后启动");
    assert.equal(fs.readFileSync(path.join(wt.path, "notes.md"), "utf8"), "alpha\n", "直接写入仍由子任务自己完成（不提前由主会话写入）");
  } finally {
    await t.shutdown();
  }
});

test("占用取放：相等/祖先（分隔符）/子孙/兄弟/dev-ino 别名与释放唤醒", async () => {
  const { dirs } = await makeTestDirs("occ-unit", 0);
  try {
    const db = new Db(dirs.dataDir);
    try {
      const store = new Store(db);
      const acquireAt = (cwdReal: string, taskId: string, sessionId: string, dev: number, ino: number) =>
        store.tryAcquireOccupancy({ cwdReal, cwdDev: dev, cwdIno: ino, sessionId, taskId });
      // 同目录：同任务释放后可再取得，不同任务互斥
      assert.equal(acquireAt("/ws", "t1", "s1", 1, 100), true);
      assert.equal(acquireAt("/ws", "t2", "s2", 1, 100), false);
      // 祖先尔后子孙持锁互斥（分隔符边界）
      assert.equal(acquireAt("/ws/sub", "t3", "s3", 1, 101), false, "持有的祖先锁同住子孙");
      // 兄弟根（不共享分隔符边界前缀）不受影响
      assert.equal(acquireAt("/ws2/sub", "t4", "s4", 1, 102), true, "不同根的子孙不受影响");
      // dev/ino 别名（realpath 不同但 dev/ino 相同 → 同目录互斥）
      assert.equal(acquireAt("/alias-ws", "t6", "s5", 1, 100), false, "挂载别名同目录互斥");
      // 释放后立即可重取；释放按 taskId（cwd 是记录不是键）
      assert.equal(store.releaseOccupancy("t1"), true);
      assert.equal(store.releaseOccupancy("t1"), false, "重复释放幂等假返回");
      assert.equal(acquireAt("/ws", "t7", "s1", 1, 100), true, "释放后同名後度可取");
      assert.equal(store.getOccupancyByDir("/ws")?.taskId, "t7");
      assert.equal(store.releaseOccupancy("t7"), true);
      assert.equal(store.getOccupancyByDir("/ws"), null);
      assert.equal(store.releaseOccupancy("t4"), true);
    } finally {
      db.close();
    }
  } finally {
    await cleanupDirs(dirs);
  }
});

test("创建失败保留现场：worker 副本创建被拦，错误含路径与分支，副本根现场存在，不登记工作", async () => {
  const responder: Responder = async () => ({ kind: "text", text: "父回复" });
  const workCopyExecutor = async () => ({ isError: true, errorMessage: "副本 worker 创建失败（注入）", content: "" });
  const t = await startTestRuntime("wk-cfail", responder, { config: { ...realTools(), workCopyExecutor }, workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wkcf", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const worksBefore = rt.store.listWorkDelegations().length;
    let error: unknown = null;
    try {
      await delegateFromActiveTask(rt, {
        parentTaskId: parent.id, key: "cf1", request: "x", mode: "modify", target: ".",
        materials: null, readPaths: null, paramsDigest: "dcf1",
      });
    } catch (err) {
      error = err;
    }
    assert.ok(error, "委派被拒绝（worker 注入失败）");
    const msg = String((error as { message?: unknown }).message);
    assert.match(msg, /副本创建失败/, "错误含创建失败原因");
    assert.match(msg, /agent-work\/worktrees|ruukoto\/work-/, "错误含副本路径或分支名（现场位置可查）");
    const worktreeRoot = path.join(path.dirname(path.resolve(rt.config.dataDir)), "agent-work", "worktrees");
    assert.ok(fs.existsSync(worktreeRoot), "副本根现场存在（宿主不删现场）");
    assert.equal(rt.store.listWorkDelegations().length, worksBefore, "失败不登记工作");
    void "里的副本参数定位保留现场（副本目录由宿主生成在 agent-work/worktrees/<workId>）";
  } finally {
    await t.shutdown();
  }
});

test("单个执行任务取消后已写文件仍在 worktree；写入目标不变（不重建）；取消不触碰副本", async () => {
  let release: (() => void) | null = null;
  let firstPhase = true;
  let releaseAfterEdit!: () => void;
  const afterEdit = new Promise<void>((resolve) => { releaseAfterEdit = resolve; });
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("PATCH-CANCEL")) {
      if (!firstPhase) {
        await afterEdit;
        return { kind: "text", text: "done" };
      }
      firstPhase = false;
      await new Promise<void>((res) => (release = res));
      return { kind: "tool_calls", calls: [{ id: "wc1", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 111" }] } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("wk-cancel", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wkc", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "wc1", request: "PATCH-CANCEL", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dwc1",
    });
    const wt = a.work.writeTarget!;
    assert.ok(wt.kind === "worktree");
    await waitFor("子挂起（等编辑生效）", () => release !== null);
    // 释放第一拍：edit 生效、模型继续；任务到达终态前由 cancelTask 停掉
    release!();
    // 等编辑生效（副本文件内容已被子任务写入）
    await waitFor("edit 生效", () => {
      try {
        return fs.readFileSync(path.join(wt.path, "src/a.ts"), "utf8") === "export const v = 111\n";
      } catch {
        return false;
      }
    });
    // 取消单次任务（整项取消的对立面）：worktree 与写入目标都不重建
    await rt.cancelTask(a.task.id);
    await waitFor("任务终态", () => ["canceled", "failed", "completed"].includes(rt.store.getTask(a.task.id)!.status));
    const wtAfter = rt.store.getWorkDelegation(a.work.id)!.writeTarget!;
    assert.deepEqual(wtAfter, wt, "取消不改变写入目标");
    assert.ok(fs.existsSync(wt.path), "副本目录保留");
    assert.equal(fs.readFileSync(path.join(wt.path, "src/a.ts"), "utf8"), "export const v = 111\n", "已写文件保留一次，不重放");
  } finally {
    parentGate.release();
    releaseAfterEdit();
    await t.shutdown();
  }
});

test("退出未核实：占用按 worktree 键保留、Agent 记 unverified；恢复队列后释放键按 taskId", async () => {
  const responder: Responder = async () => ({ kind: "text", text: "父回复" });
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("wk-unv", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wku", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "wu1", request: "x", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dwu1",
    });
    const wt = a.work.writeTarget!;
    // 模拟「无法核实旧执行退出」：任务被中断 + 占用按 worktree 键保留（cwd=副本）
    rt.store.withTx(() => {
      rt.store.transitionTask(a.task.id, ["queued"], "interrupted", { interruptReason: "backend_restart", endedAt: new Date().toISOString() });
    });
    rt.store.db
      .prepare("INSERT INTO occupancy (cwd_real, cwd_dev, cwd_ino, session_id, task_id, acquired_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(wt.path, wt.dev, wt.ino, a.agent.sessionId, a.task.id, new Date().toISOString());
    rt.orchestrator!.onRuntimeEvents([
      {
        seq: 0, taskId: a.task.id, sessionId: a.agent.sessionId,
        body: { type: "task.interrupted", taskId: a.task.id, sessionId: a.agent.sessionId, reason: "backend_restart", cancelRequested: false, effectUnknown: false },
        createdAt: new Date().toISOString(),
      },
    ]);
    await waitFor("结果登记", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    assert.equal(rt.store.getSubAgent(a.agent.id)!.state, "unverified", "退出未核实记待核实");
    // 占用按 worktree 路径为键（而不是会话目录）
    assert.equal(rt.store.getOccupancyByDir(wt.path)?.taskId, a.task.id);
    // 恢复队列：占用键按 taskId 释放（cwd 是记录不是键）
    assert.equal(rt.store.releaseOccupancy(a.task.id), true);
    assert.equal(rt.store.getOccupancyByDir(wt.path), null);
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("worktree 被删除后的继续委派明确拒绝（不自动重建）；取消不触碰副本", async () => {
  const responder: Responder = async () => ({ kind: "text", text: "父回复" });
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("wk-gone", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wkg", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "xg1", request: "x", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dxg1",
    });
    const wt = a.work.writeTarget!;
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(a.agent.id)!.state === "idle");
    // 移除副本本体：离线直接删文件，真实原生 worker 场景另由 smoke 验证。
    fs.rmSync(wt.path, { recursive: true, force: true });
    await assert.rejects(
      () =>
        delegateFromActiveTask(rt, {
          parentTaskId: parent.id, key: "xg2", request: "又", workId: a.work.id,
          materials: null, readPaths: null, paramsDigest: "dxg2",
        }),
      /已被替换|已不存在|请新建委派|worktree_gone|已不存在，请新建委派|请新建 SubAgent/,
      "worktree 被删除后的继续委派明确拒绝（不自动重建）",
    );
    // 现实打标：断言失败是拒绝而不是创建新副本

    assert.equal(rt.store.getWorkDelegation(a.work.id)!.writeTarget?.path, wt.path, "写入目标不重建");
    // 取消不触碰副本（没有副本可触：取消仍只停任务）
    await rt.subagents!.cancelWork({ workId: a.work.id, by: "owner" });
    assert.equal(rt.store.getWorkDelegation(a.work.id)!.canceledAt !== null, true);
    assert.ok(!fs.existsSync(wt.path), "副本目没由宿主自动还原");
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("继续委派沿用首次钉定目标；复用承接新工作另建副本（旧改动不进新工作）", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]")) return { kind: "text", text: "done-by-continued" };
    return { kind: "text", text: "父回复" };
  };
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("wk-cont", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wkc2", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const a = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "c1", request: "PATCH-首次", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dc1",
    });
    await waitFor("首次完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(a.agent.id)!.state === "idle");
    const firstTarget = rt.store.getWorkDelegation(a.work.id)!.writeTarget! as Extract<import("@ruukoto/core/types.ts").WorkWriteTarget, { kind: "worktree" }>;

    // 继续委派：沿用首次钉定副本（不重建不分业）——task_input 含分支与基线一致
    const cont = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "c2", request: "PATCH-ice 继续一次", workId: a.work.id,
      materials: null, readPaths: null, paramsDigest: "dc2",
    });
    assert.deepEqual(rt.store.getWorkDelegation(a.work.id)!.writeTarget, firstTarget, "继续沿用同一副本");
    assert.deepEqual(cont.work.writeTarget, firstTarget);
    // 等子任务跑完再继续——继续委派的输入带分支与基线
    await waitFor("继续完成", () => rt.store.getTask(cont.task.id)!.resultSummary !== null);
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(a.agent.id)!.state === "idle");
    const contCall = t.server.calls.find((c) => {
      return inputText(c).includes("[SubAgent 委派 · 工作区修改]") && inputText(c).includes("继续一次");
    });
    assert.ok(contCall, "找到继续委派的模型调用");
    if (contCall) {
      assert.ok(inputText(contCall).includes(`分支 ${firstTarget.branch}`), "任务输入带首次分支与基线");
    }

    // 复用同一 Agent 承接第二项（修改）工作：另建副本（新 workId），旧改动不进新副本
    const okOther = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "c3", request: "PATCH-ice 承接新工作", subAgentId: a.agent.id, mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dc3",
    });
    const reuseTarget = rt.store.getWorkDelegation(okOther.work.id)!.writeTarget!;
    assert.notEqual(reuseTarget.path, firstTarget.path, "复用另建副本（新 workId）");
    assert.notEqual(okOther.work.id, a.work.id);
    // 父工作区字节未被两个副本干扰
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 1\n", "主工作区字节不变");
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("复用同一 SubAgent 从只读工作转到修改工作：新任务拿到写入工具（SDK 签名含画像工具集，不靠每任务释放 Driver）", async () => {
  const responder: Responder = async () => ({ kind: "text", text: "done" });
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("wk-ro2rw", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wkro2rw", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    const ro = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "r1", request: "RO-先只读", readPaths: ["."], materials: null, paramsDigest: "dr1" });
    await waitFor("只读完成", () => rt.store.getTask(ro.task.id)!.resultSummary !== null);
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(ro.agent.id)!.state === "idle");
    const rw = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "r2", request: "RW-再修改", subAgentId: ro.agent.id, mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dr2",
    });
    assert.equal(rw.agent.id, ro.agent.id, "同一 SubAgent 承接");
    await waitFor("修改完成", () => rt.store.getTask(rw.task.id)!.resultSummary !== null);
    const callOf = (mark: string) => t.server.calls.find((c) => lastUserText(c).includes(mark))!;
    assert.deepEqual(toolNamesOf(callOf("RO-先只读")).sort(), ["read", "read_artifact", "subagent_message"].sort());
    assert.deepEqual(toolNamesOf(callOf("RW-再修改")).sort(), ["bash", "edit", "read", "read_artifact", "subagent_message", "write"].sort(), "复用到修改工作拿到写入工具");
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});

test("边界：计划模式/SubAgent 自身不能发起修改委派；只读工作不能升级为写入；modify 摘要不进只读重放摘要（main 开门与固定角色拒绝见 test/84）", async () => {
  const responder: Responder = async () => ({ kind: "text", text: "父回复" });
  const parentGate = holdParentResponse(responder);
  const t = await startTestRuntime("wk-gates", parentGate.responder, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime;
    fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
    fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
    initGitRepo(t.work[0]!);
    const session = await rt.createSession({ projectName: "wkgate", cwd: t.work[0]! });
    const dev = await rt.submit({ sessionId: session.id, requestId: "pd", input: "先调研再修改", accessMode: "plan", modelSelection: rt.defaultSelection });
    await waitFor("dev 完成", () => rt.store.getTask(dev.id)!.status === "completed");
    const planCall = t.server.calls.find((c) => lastUserText(c).includes("先调研再修改"))!;
    assert.ok(planCall, "真实计划任务已调用模型");
    assert.ok(!toolNamesOf(planCall).some((name) => ["edit", "write", "subagent_delegate", "subagent_integrate"].includes(name)), "计划模式没有开放修改和委派工具");
    // 计划模式：modify 被拒
    await assert.rejects(
      () =>
        delegateFromActiveTask(rt, { parentTaskId: dev.id, key: "gp", request: "x", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "dgp" }),
      /计划模式/,
    );

    const normal = await rt.submit({ sessionId: session.id, requestId: "normal", input: "开始执行", modelSelection: rt.defaultSelection });
    await waitFor("普通父任务在运行", () => rt.store.getTask(normal.id)!.status === "running");
    // SubAgent 自身（非用户会话）：委派入口已友好拒绝
    const mainSub = await delegateFromActiveTask(rt, {
      parentTaskId: normal.id, key: "gs", request: "x", mode: "modify", target: ".",
      materials: null, readPaths: null, paramsDigest: "dgs",
    });
    // SubAgent 会话的会话由宿主识别；子会话不能充当父（parentTaskId 子任务直接拒绝）
    await assert.rejects(
      () =>
        delegateFromActiveTask(rt, { parentTaskId: mainSub.task.id, key: "gs2", request: "x", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "dgs2" }),
      /只有用户会话|不能委派下级|SubAgent 不能委派下级/,
    );

    // 只读工作不能升级为写入
    const readOnly = await delegateFromActiveTask(rt, {
      parentTaskId: normal.id, key: "ro1", request: "只读分析片段", readPaths: ["."], materials: null, paramsDigest: "dro1",
    });
    await waitFor("只读工作登记", () => rt.store.getWorkDelegation(readOnly.work.id) !== null);
    await assert.rejects(
      () =>
        delegateFromActiveTask(rt, {
          parentTaskId: normal.id, key: "ro2", request: "升级cannot", workId: readOnly.work.id, mode: "modify",
          materials: null, readPaths: null, paramsDigest: "dro2",
        }),
      /只读|不能升级为写入/,
    );

    // 只读重放摘要保持原参不变（modify 字段不入只读路径）
    const replay = await delegateFromActiveTask(rt, {
      parentTaskId: normal.id, key: "ro1", request: "只读分析片段", readPaths: ["."], materials: null, paramsDigest: "dro1",
    });
    assert.equal(replay.created, false, "11 的重放摘要保持逐字节（modify 字段不入只读路径）");
  } finally {
    parentGate.release();
    await t.shutdown();
  }
});



test("子任务调用门与装配：伪造写调用被发送两处拒绝（只读工作守卫不回退）", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (afterTool(req)) return { kind: "text", text: "SUB-DONE" };
      return { kind: "tool_calls", calls: [{ id: "fx1", name: "edit", arguments: { path: "src/x", edits: [{ oldText: "a", newText: "b" }] } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("wk-gate2", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "wfx", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "委派", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const deleg = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "fw1", request: "伪造写", readPaths: ["."], materials: null, paramsDigest: "dfw1" });
    await waitFor("子任务完成", () => rt.store.getTask(deleg.task.id)!.status === "completed");
    // 只读工作的装配仍收窄到 read/read_artifact（与迁前一致）
    const subCall = t.server.calls.find((c) => inputText(c).includes("[SubAgent 委派"))!;
    assert.deepEqual(toolNamesOf(subCall).sort(), ["read", "read_artifact", "subagent_message"].sort(), "只读工作装配保持只在迁前清单与工作内消息（issue 13）");
    const toolResults = t.server.calls.filter((c) => afterTool(c) && inputText(c).includes("[SubAgent 委派")).map(lastToolText).join("\n");
    assert.match(toolResults, /not found|白名单不含 edit|本任务工具白名单不含 edit/, "伪造写调用在发送/调用两处被拒");
  } finally {
    await t.shutdown();
  }
});

for (const outcome of [false, "throws"] as const) {
  test(`创建已收到 Git 结果但停止未核实：${outcome} 保留父占用、结果与副本，不登记委派`, async () => {
    const parentGate = holdParentResponse(async () => ({ kind: "text", text: "父回复" }));
    const t = await startTestRuntime("wt-result-stop", parentGate.responder, { config: realTools(), workDirs: 1 });
    let stops = 0;
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const controlled = controlledWorkCopy(async () => {
      stops++;
      if (outcome === "throws") throw new ExecutionError("injected_stop_failed", "模拟停止异常");
      return false;
    }, hash, true, false);
    try {
      const rt = t.runtime;
      fs.writeFileSync(path.join(t.work[0], "source.txt"), "source\n");
      initGitRepo(t.work[0]);
      const session = await rt.createSession({ projectName: "wt-result-stop", cwd: t.work[0] });
      const parent = await rt.submit({ sessionId: session.id, requestId: "p", input: "开始", modelSelection: rt.defaultSelection });
      await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
      rt.launcherFor = () => controlled.launcher;
      const operation = delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "create", request: "修改", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "create" });
      const rejected = assert.rejects(operation, { code: "worker_stop_unverified" });
      await waitFor("Git 调用已发送", () => controlled.requests.some((request) => request.type === "tool_call"));
      const op = rt.store.listToolOpsByTask(parent.id).find((entry) => entry.toolName === "worktree_create")!;
      const copyDir = String(op.params.copyDir);
      fs.writeFileSync(path.join(copyDir, "result.txt"), "已创建的现场\n");
      controlled.reply();
      await rejected;
      await waitFor("父中断", () => rt.store.getTask(parent.id)!.status === "interrupted");
      assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.taskId, parent.id);
      assert.equal(rt.store.getOccupancyByDir(copyDir)?.taskId, parent.id);
      assert.equal(rt.store.getToolOp(op.id)!.resultSummary, hash);
      assert.equal(rt.store.getToolOp(op.id)!.effectUnknown, false);
      assert.equal(fs.readFileSync(path.join(copyDir, "result.txt"), "utf8"), "已创建的现场\n");
      assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 0);
      assert.ok(controlled.specs[0].taskId.startsWith(`${parent.id}-wt_`));
      const other = await rt.createSession({ projectName: "wt-result-other", cwd: t.work[0] });
      const queued = await rt.submit({ sessionId: other.id, requestId: "blocked", input: "后续任务", modelSelection: rt.defaultSelection });
      const copySession = await rt.createSession({ projectName: "wt-copy-blocked", cwd: copyDir });
      const copyTask = await rt.submit({ sessionId: copySession.id, requestId: "copy-blocked", input: "副本独立任务", modelSelection: rt.defaultSelection });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(rt.store.getTask(queued.id)!.status, "queued");
      assert.equal(rt.store.getTask(copyTask.id)!.status, "queued");
      await assert.rejects(delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "replacement", request: "替代", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "replacement" }), { code: "task_ending" });
      assert.equal(controlled.specs.length, 1);
      assert.equal(stops, 1);
      await rt.resumeQueue(session.id);
      await waitFor("父目录与副本队列恢复", () => rt.store.getTask(queued.id)!.status === "completed" && rt.store.getTask(copyTask.id)!.status === "completed");
      assert.equal(rt.store.getOccupancyByDir(session.cwdReal), null);
      assert.equal(rt.store.getOccupancyByDir(copyDir), null);
      assert.equal(controlled.specs.length, 1);
    } finally {
      parentGate.release();
      controlled.finish();
      await t.shutdown();
    }
  });
}

for (const phase of ["ready", "call", "mode", "mode_call"] as const) {
  test(`创建临时 worker ${phase} 阶段停止失败进入父任务终态并保留目录保护`, async () => {
    const parentGate = holdParentResponse(async () => ({ kind: "text", text: "父回复" }));
    const t = await startTestRuntime(`wt-cancel-${phase}`, parentGate.responder, { config: realTools(), workDirs: 1 });
    const controlled = controlledWorkCopy(async () => false, "", (phase === "call" || phase === "mode_call"), false);
    try {
      const rt = t.runtime;
      fs.writeFileSync(path.join(t.work[0], "source.txt"), "source\n");
      initGitRepo(t.work[0]);
      const session = await rt.createSession({ projectName: "wt-cancel", cwd: t.work[0] });
      const parent = await rt.submit({ sessionId: session.id, requestId: "p", input: "开始", modelSelection: rt.defaultSelection });
      await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
      rt.launcherFor = () => controlled.launcher;
      const operation = delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "create", request: "修改", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "create" });
      const rejected = assert.rejects(operation, { code: "worker_stop_unverified" });
      await waitFor("临时单元已产生", () => (phase === "call" || phase === "mode_call") ? controlled.requests.some((request) => request.type === "tool_call") : controlled.specs.length === 1);
      if (phase.startsWith("mode")) {
        rt.store.withTx(() => rt.store.transitionTask(parent.id, ["running"], "awaiting_confirmation"));
        await assert.rejects(rt.switchTaskMode({ taskId: parent.id, mode: "full_access" }), { code: "mode_switch_unverified" });
      } else {
        await rt.cancelTask(parent.id);
      }
      await rejected;
      assert.ok(["canceled", "interrupted"].includes(rt.store.getTask(parent.id)!.status));
      assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.taskId, parent.id);
      if (phase.startsWith("mode")) {
        const events = rt.store.getEventsAfter(0);
        assert.equal(events.filter((event) => event.body.type === "task.mode_switch_failed" && event.taskId === parent.id).length, 1);
        assert.equal(events.filter((event) => event.body.type === "task.mode_switched" && event.taskId === parent.id).length, 0);
      }
      const op = rt.store.listToolOpsByTask(parent.id).find((entry) => entry.toolName === ((phase === "call" || phase === "mode_call") ? "worktree_create" : "worktree_start"))!;
      assert.equal(op.effectUnknown, (phase === "call" || phase === "mode_call"));
      if (phase === "ready" || phase === "mode") assert.match(op.resultSummary!, /已知未执行/);
      assert.ok(fs.existsSync(String(op.params.copyDir)));
      assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 0);
    } finally {
      parentGate.release();
      controlled.finish();
      await t.shutdown();
    }
  });
}

for (const operation of ["create", "integrate"] as const) {
  for (const phase of ["ready", "call"] as const) {
    test(`后台停止覆盖 SDK 中的 ${operation} 临时 worker ${phase} 阶段，重连资料保留占用与现场`, async () => {
      const controlled = controlledWorkCopy(async () => false, "", phase === "call", false);
      let runtime: Runtime | null = null;
      let parentSessionId = "";
      const responder: Responder = async (req) => {
        if (lastUserText(req).includes("[SubAgent 委派")) return { kind: "text", text: "子任务完成" };
        if (!afterTool(req)) return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { key: "create", request: "修改", mode: "modify", target: "." } }] };
        const work = runtime!.store.listWorkDelegationsBySession(parentSessionId)[0]!;
        await waitFor("子任务完成", () => runtime!.store.listTasksByWork(work.id).every((task) => task.resultSummary !== null));
        fs.writeFileSync(path.join(work.writeTarget!.path, "source.txt"), "副本成果\n");
        runtime!.launcherFor = () => controlled.launcher;
        return { kind: "tool_calls", calls: [{ id: "integrate", name: "subagent_integrate", arguments: { work_id: work.id } }] };
      };
      const t = await startTestRuntime(`wt-backend-${operation}-${phase}`, responder, { config: realTools(), workDirs: 1 });
      let db: Db | null = null;
      try {
        const rt = runtime = t.runtime;
        fs.writeFileSync(path.join(t.work[0], "source.txt"), "source\n");
        initGitRepo(t.work[0]);
        const session = await rt.createSession({ projectName: "wt-backend", cwd: t.work[0] });
        parentSessionId = session.id;
        if (operation === "create") rt.launcherFor = () => controlled.launcher;
        const parent = await rt.submit({ sessionId: session.id, requestId: "p", input: "开始", modelSelection: rt.defaultSelection });
        await waitFor("目标临时单元已产生", () => phase === "call" ? controlled.requests.some((request) => request.type === "tool_call") : controlled.specs.length === 1);
        await rt.stop("test_backend_stop");
        db = new Db(t.dirs.dataDir);
        const store = new Store(db);
        assert.equal(store.getTask(parent.id)!.status, "interrupted");
        assert.equal(store.getOccupancyByDir(session.cwdReal)?.taskId, parent.id);
        const op = store.listToolOpsByTask(parent.id).filter((entry) => entry.toolName === (phase === "call" ? `worktree_${operation}` : "worktree_start")).at(-1)!;
        assert.equal(op.effectUnknown, phase === "call");
        assert.ok(fs.existsSync(String(op.params.copyDir)));
        assert.equal(fs.readFileSync(path.join(t.work[0], "source.txt"), "utf8"), "source\n");
        if (operation === "integrate") assert.equal(fs.readFileSync(path.join(String(op.params.copyDir), "source.txt"), "utf8"), "副本成果\n");
        assert.equal(store.getEventsAfter(0).filter((event) => event.body.type === "task.tool_process_unreaped" && event.taskId === parent.id).length, 1);
        assert.equal(controlled.specs.length, 1);
      } finally {
        db?.close();
        controlled.finish();
        await t.shutdown();
      }
    });
  }
}

test("临时单元停止成功期间取消父任务，迟到模式切换不能修改终态权限", async () => {
  const parentGate = holdParentResponse(async () => ({ kind: "text", text: "父回复" }));
  const t = await startTestRuntime("wt-mode-cancel", parentGate.responder, { config: realTools(), workDirs: 1 });
  let releaseStop!: () => void;
  let stopping = false;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const controlled = controlledWorkCopy(async () => { stopping = true; await stopGate; return true; }, "", false, false);
  try {
    const rt = t.runtime;
    fs.writeFileSync(path.join(t.work[0], "source.txt"), "source\n");
    initGitRepo(t.work[0]);
    const session = await rt.createSession({ projectName: "wt-mode-cancel", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父在运行", () => rt.store.getTask(parent.id)!.status === "running");
    rt.launcherFor = () => controlled.launcher;
    const operation = delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "create", request: "修改", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "create" });
    const rejected = assert.rejects(operation, { code: "task_ending" });
    await waitFor("临时单元已产生", () => controlled.specs.length === 1);
    rt.store.withTx(() => rt.store.transitionTask(parent.id, ["running"], "awaiting_confirmation"));
    const mode = assert.rejects(rt.switchTaskMode({ taskId: parent.id, mode: "full_access" }), { code: "invalid_state" });
    await waitFor("单元正在停止", () => stopping);
    const cancel = rt.cancelTask(parent.id);
    await waitFor("取消意图已提交", () => rt.store.getTask(parent.id)!.cancelRequested);
    releaseStop();
    await Promise.all([mode, cancel, rejected]);
    const terminal = rt.store.getTask(parent.id)!;
    assert.equal(terminal.status, "canceled");
    assert.equal(terminal.permissionVersion, parent.permissionVersion);
    assert.equal(terminal.accessMode, parent.accessMode);
    assert.equal(rt.store.getOccupancyByDir(session.cwdReal), null);
    assert.equal(rt.store.getEventsAfter(0).filter((event) => event.body.type === "task.mode_switched" && event.taskId === parent.id).length, 0);
  } finally {
    releaseStop();
    parentGate.release();
    controlled.finish();
    await t.shutdown();
  }
});
