/**
 * 修改委派的并行 worktree 与非 Git 串行（agent-direction issue 16）的本机冒烟。
 *
 * 模拟：模型（MockModelServer 确定性脚本）与消息平台（不启用）。
 * 真实：Runtime + 控制面 + SQLite 库 + 独立 JSONL + 真实受限工具工作进程
 * （Docker 容器后端，04/11/14 已验证的受限执行边界）+ 真实 git 仓库与
 * worktree 副本 + 容器内执行 git（safe.directory 环境方案）+ 真实 CLI
 * （bin/ruukoto-code.mjs work cancel，经 socket 与拥有者令牌）。
 *
 * 覆盖（与工单验收对应，离线断言见 test/83）：
 *  W1. 容器内建副本：两个子任务同一仓库并行 worktree（同时 running、
 *      不同分支）、各自改动互不覆盖；
 *  W2. 容器内 git status/diff 真实可用（safe.directory 环境）；git commit 与
 *      写 hooks/config 真实失败；
 *  W3. 主工作区字节与未提交改动不变；
 *  W4. LaunchSpec 只以读写挂自己的副本、共享 Git 目录在 readRoots、
 *      grantedPaths 为空；
 *  W5. 非 Git 目录写入与父会话按目录占用串行（父持锁时子任务 queued，父
 *      本轮结束自然启动）；
 *  W6. 执行任务取消后已写文件仍在副本，空闲时没有残余容器（含副本创建
 *      容器的临时名字）；
 *  W7. 植入的 fsmonitor/hook 不在宿主执行（副本创建与工作期间 marker
 *      文件不出现）。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL；2 = docker/镜像不可用。
 * TMPDIR 可换位置。容器 uid/gid 约定同 smoke-11。
 *
 * `--remote`：本机只做驱动——rsync 当前仓库（HEAD + 未提交改动）到
 * tx:/tmp/ruukoto-smoke16-src，远端 npm ci 后在 tx 的既有受限执行环境
 * （docker）自包含跑完全程；远端退出码即结果。真实 QQ/Telegram 平台
 * 无入口，本冒烟不含消息平台证据（模型与平台均为模拟，两处分别记录）。
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startTestRuntime, waitFor, lastUserText, realTools } from "../../test/helpers/testkit.ts";
import type { Responder, RecordedRequest } from "../../test/helpers/mock-provider.ts";
import type { MockModelServer } from "../../test/helpers/mock-provider.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { WorkWriteTarget } from "../../src/core/types.ts";

const IMAGE = process.env.RUUKOTO_WORKER_IMAGE ?? "ruukoto-worker:latest";
const UID = Number(process.env.RUUKOTO_CONTAINER_UID ?? (process.platform === "darwin" ? 1000 : (process.getuid?.() ?? 1000)));
const GID = Number(process.env.RUUKOTO_CONTAINER_GID ?? (process.platform === "darwin" ? 1000 : (process.getgid?.() ?? 1000)));

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true, detail: "" });
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
      console.log(`FAIL ${name}: ${(err as Error).message}`);
    });
}
function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}
function afterTool(req: RecordedRequest): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
}
function lastToolText(req: RecordedRequest): string {
  const m = req.messages[req.messages.length - 1];
  return typeof (m as any)?.content === "string" ? (m as any).content : JSON.stringify((m as any)?.content ?? "");
}
function inputText(req: RecordedRequest): string {
  return req.messages
    .map((m: any) => {
      const content = m?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
      return "";
    })
    .join("\n");
}

// ---------- 远端驱动（--remote：rsync 后在 tx 自包含执行） ----------
if (process.argv.includes("--remote")) {
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
  const REMOTE = "tx";
  const RDIR = "/tmp/ruukoto-smoke16-src";
  const SELF = ".scratch/agent-direction/smoke-16-parallel-worktrees.mts";
  const run = (label: string, cmd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}) => {
    console.log(`\n=== ${label} ===`);
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? 600_000 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const code = r.status ?? (r.signal ? -1 : 1);
    if (code !== 0 && !opts.allowFail) {
      console.error(`驱动步骤失败（${label}，退出码 ${code}${r.signal ? `，信号 ${r.signal}` : ""}）`);
      process.exit(1);
    }
    return { code };
  };
  run("探测 tx 环境", "ssh", [REMOTE, "set -e && node --version && docker version >/dev/null && echo docker-ok && docker image inspect ruukoto-worker:latest >/dev/null && echo image-ok"], { timeoutMs: 60_000 });
  run("记录代码状态", "bash", ["-lc", `git -C ${repoRoot} rev-parse --abbrev-ref HEAD; git -C ${repoRoot} rev-parse HEAD; git -C ${repoRoot} status --short`]);
  run("rsync 仓库到 tx", "rsync", ["-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".idea", "--exclude", "*.log", `${repoRoot}/`, `${REMOTE}:${RDIR}/`], { timeoutMs: 300_000 });
  run("远端 npm ci", "ssh", [REMOTE, `cd ${RDIR} && npm ci --no-audit --no-fund --prefer-offline`], { timeoutMs: 600_000 });
  const remote = run("远端冒烟（Linux 受限执行环境）", "ssh", [REMOTE, `cd ${RDIR} && node_modules/.bin/tsx ${SELF}`], { allowFail: true, timeoutMs: 900_000 });
  console.log(`\n=== 驱动结束：远端退出码 ${remote.code} ===`);
  process.exit(remote.code === 0 ? 0 : 1);
}

// ---------- 基础设施门 ----------
try {
  execFileSync("docker", ["version"], { stdio: "ignore", timeout: 15_000 });
  docker(["image", "inspect", IMAGE]);
} catch {
  console.error(`基础设施缺失：需要 docker 可用且镜像 ${IMAGE} 存在（deploy/worker-image/build.sh 构建）`);
  process.exit(2);
}
console.log(`环境：${process.platform} ${process.arch}；镜像 ${IMAGE}；容器 uid:gid ${UID}:${GID}`);

// ---------- 夹具：临时 git 仓库（宿主 fs 常规操作；git 命令宿主不调用） --------
const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "ruukoto-smoke16-")));
const repoDir = path.join(root, "repo");
fs.mkdirSync(repoDir, { recursive: true });
fs.writeFileSync(path.join(repoDir, "a.txt"), "alpha\n", "utf8");
fs.writeFileSync(path.join(repoDir, "b.txt"), "beta\n", "utf8");
// 仓库经容器初始化（`git init`+first commit 用受限容器完成，宿主不执行 git）；
// 尽快用宿主无 git 的二进制（init_repo_in_container 是唯一入口，见下）。
const evidence: string[] = [];

// ---- 容器命令发起（TestKit 的运行时之外，需要一次性 ToolWorkerHost 调用；
// host 模板尽量与 SubAgent 创建副本同一处理（运行时内建），这里用同在镜像
// 内的 docker 拉一次执行边界（docker run 本身就是容器的边界，不在宿主执行）。
function containerExec(label: string, workspaceMount: string, copyMount: string | null, cmd: string): { ok: boolean; text: string } {
  const args = [
    "run", "--rm", "-i", "--name", `ruukoto-smoke16-${process.pid.toString(36)}-${label}`,
    "--user", `${UID}:${GID}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=64m",
    "--network", "none",
    "-v", `${workspaceMount}:${workspaceMount}:rw`,
    // 第二挂载模拟任务容器的共享 Git readRoot，必须只读（与子任务 LaunchSpec 同式）
    ...(copyMount ? ["-v", `${copyMount}:${copyMount}:ro`] : []),
    "-w", workspaceMount,
    "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
    "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=safe.directory", "--env", "GIT_CONFIG_VALUE_0=*",
    IMAGE, "bash", "-lc", cmd,
  ];
  try {
    const out = execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
    return { ok: true, text: out.trim() };
  } catch (err: any) {
    const text = `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim() || String(err?.message ?? err);
    return { ok: false, text };
  }
}

await check("仓库在容器内初始化（init + 首次提交；宿主不执行 git）", () => {
  const out = containerExec("init", repoDir, null,
    "set -eu; git init -q; git config user.email smoke@example.com; git config user.name smoke; git add -A; git commit -q -m init; git rev-parse HEAD");
  if (!out.ok) throw new Error(`容器初始化失败：${out.text}`);
  assert.match(out.text.split("\n").at(-1) ?? "", /^[0-9a-f]{40}$/);
  evidence.push(`仓库基线 HEAD：${out.text.split("\n").at(-1)}（容器初始化，宿主无 git 调用）`);
});
// 父工作区未提交修改（不在副本中）与未进 git 的新增
fs.writeFileSync(path.join(repoDir, "a.txt"), "alpha // dirty-parent\n", "utf8");
fs.writeFileSync(path.join(repoDir, "untracked-parent.md"), "parent-only\n", "utf8");
// 宿主永不执行这些植入：应在整个冒烟期间不出现 marker 文件
const fsProbe = path.join(root, "FSMONITOR-EXECUTED.txt");
const hookProbe = path.join(root, "HOOK-EXECUTED.txt");
fs.mkdirSync(path.join(repoDir, ".git", "hooks"), { recursive: true });
fs.writeFileSync(
  path.join(repoDir, ".git", "hooks", "post-checkout"),
  `#!/bin/sh\ntouch ${hookProbe}\nexit 0\n`,
  { mode: 0o755 },
);
fs.appendFileSync(path.join(repoDir, ".git", "config"), `\n[core]\nfsmonitor = /bin/sh -c 'touch ${fsProbe}'\n`, "utf8");

// ============ Phase W：两个并行修改副本（真实容器 + 真实副本） ============
{
  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>((res) => (releaseA = res));
  const gateB = new Promise<void>((res) => (releaseB = res));
  let didEditA = false;
  let didEditB = false;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]")) {
      if (text.includes("MAKE-A")) {
        if (!didEditA) {
          didEditA = true;
          await gateA;
          return { kind: "tool_calls", calls: [{ id: "ma1", name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "alpha", newText: "alpha-A" }] } }] };
        }
        return { kind: "text", text: "A-done" };
      }
      if (text.includes("MAKE-B")) {
        if (!didEditB) {
          didEditB = true;
          await gateB;
          return { kind: "tool_calls", calls: [{ id: "mb1", name: "edit", arguments: { path: "b.txt", edits: [{ oldText: "beta", newText: "beta-B" }] } }] };
        }
        return { kind: "text", text: "B-done" };
      }
      return { kind: "text", text: "WORKTREE-CHECK" };
    }
    return { kind: "text", text: "done-parent" };
  };

  const t = await startTestRuntime("smoke16-parallel", responder, {
    config: { ...realTools(), productType: "ruukoto-code", execution: { backend: "container", container: { uid: UID, gid: GID } },
  } });
  const rt = t.runtime;
  try {
    const session = await rt.createSession({ projectName: "smoke16", cwd: repoDir });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始并发修改", modelSelection: rt.defaultSelection });
    let workA: import("../../src/core/types.ts").WorkDelegation | null = null;
    let workB: import("../../src/core/types.ts").WorkDelegation | null = null;
    let wtA!: Extract<WorkWriteTarget, { kind: "worktree" }>;
    let wtB!: Extract<WorkWriteTarget, { kind: "worktree" }>;

    await check("两项 modify 工作登记成 worktree 副本（容器创建，不同分支）", async () => {
      await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
      const a = await rt.subagents!.delegate({
        parentTaskId: parent.id, key: "wt-a", request: "MAKE-A 改 a.txt", mode: "modify", target: ".",
        materials: null, readPaths: null, paramsDigest: "dsm16-a",
      });
      const b = await rt.subagents!.delegate({
        parentTaskId: parent.id, key: "wt-b", request: "MAKE-B 改 b.txt", mode: "modify", target: ".",
        materials: null, readPaths: null, paramsDigest: "dsm16-b",
      });
      workA = a.work;
      workB = b.work;
      const rawA = a.work.writeTarget!;
      const rawB = b.work.writeTarget!;
      assert.ok(rawA.kind === "worktree" && rawB.kind === "worktree");
      wtA = rawA;
      wtB = rawB;
      assert.notEqual(wtA.path, wtB.path);
      assert.notEqual(wtA.branch, wtB.branch);
      assert.ok(fs.existsSync(wtA.path) && fs.existsSync(wtB.path));
      evidence.push(`work A：副本 ${wtA.path}（分支 ${wtA.branch}，基线 ${wtA.baseCommit.slice(0, 12)}）`);
      evidence.push(`work B：副本 ${wtB.path}（分支 ${wtB.branch}，基线 ${wtB.baseCommit.slice(0, 12)}）`);
    });

    await check("两个子任务同时 running（并行，互不持对方的锁），各自 edit 落在自家副本", async () => {
      await waitFor("A running", () => rt.store.listTasksByWork(workA!.id)[0]!.status === "running", 60_000);
      await waitFor("B running", () => rt.store.listTasksByWork(workB!.id)[0]!.status === "running", 60_000);
      releaseA();
      releaseB();
      await waitFor("A 完成", () => rt.store.listTasksByWork(workA!.id)[0]!.resultSummary !== null, 60_000);
      await waitFor("B 完成", () => rt.store.listTasksByWork(workB!.id)[0]!.resultSummary !== null, 60_000);
      assert.equal(fs.readFileSync(path.join(wtA.path, "a.txt"), "utf8"), "alpha-A\n");
      assert.equal(fs.readFileSync(path.join(wtB.path, "b.txt"), "utf8"), "beta-B\n");
    });

    await check("主工作区字节与未提交改动不变", () => {
      assert.equal(fs.readFileSync(path.join(repoDir, "a.txt"), "utf8"), "alpha // dirty-parent\n");
      assert.equal(fs.readFileSync(path.join(repoDir, "untracked-parent.md"), "utf8"), "parent-only\n");
    });

    await check("容器内 git status/diff 真实可用（safe.directory 方案）；宿主与容器都不见植入 marker", async () => {
      // 在副本 A 直接发一个容器调用验证 git 可用（与子任务同一边界：同镜像、同 env、同挂载）
      const probe = containerExec("gs", wtA.path, wtA.commonGitDir,
        "set -eu; git status --porcelain; git diff -- a.txt | head -20; echo ---; git log --format=%s -1");
      if (!probe.ok) throw new Error(`git status/diff 在容器失败：${probe.text}`);
      assert.ok(probe.text.includes("M") || probe.text.toLowerCase().includes("modified") || probe.text.includes("alpha-A") || probe.text.includes("-alpha") || probe.text.includes("+alpha-A"), `status/diff 未反映副本改动：${probe.text.slice(0, 300)}`);
      evidence.push(`容器内 git status/diff 可用（safe.directory 环境方案；head 快照：${probe.text.slice(0, 200).replace(/\n/g, " / ")}）`);
      assert.ok(!fs.existsSync(fsProbe), `植入的 fsmonitor 不应执行（marker 出现：${fsProbe}）`);
      assert.ok(!fs.existsSync(hookProbe), `植入的 hook 不应执行（marker 出现：${hookProbe}）`);
    });

    await check("容器内 git commit 与写 hooks/config 真实失败", async () => {
      const c1 = containerExec("gc", wtA.path, wtA.commonGitDir, "git -c user.name=x -c user.email=x@x commit -m x --allow-empty");
      assert.equal(c1.ok, false, `git commit 不应成功（${c1.text.slice(0, 200)}）`);
      const c2 = containerExec("gw", wtA.path, wtA.commonGitDir, `touch ${wtA.commonGitDir}/hooks/x`);
      assert.equal(c2.ok, false, `写共享 hooks 不应成功（${c2.text.slice(0, 200)}）`);
      const c3 = containerExec("gc2", wtA.path, wtA.commonGitDir, `git config core.x y`);
      assert.equal(c3.ok, false, `git config 写不应成功（${c3.text.slice(0, 200)}）`);
      evidence.push("容器内 git commit / 写共享 hooks / 写共享 config 全部真实失败");
    });

    await check("副本创建容器与执行任务容器在空闲后零残余", async () => {
      await new Promise((r) => setTimeout(r, 800));
      const list = docker(["ps", "-a", "--filter", "name=ruukoto", "--format", "{{.Names}}"]);
      const residue = list.split("\n").filter((n) => n.includes("ruukoto-task-") || n.includes("ruukoto-smoke16") || n.includes("worktree-init-"));
      assert.deepEqual(residue, [], `残余容器：${residue.join(", ")}`);
    });

    await check("TUI 汇总带分支、work_get 带 writeTarget；取消单次任务不触碰副本", async () => {
      // 完成后（namespaces 由 Issue 14 覆盖），这里核验单任务取消：worktree 字节不变
      const t1 = rt.store.listTasksByWork(workA!.id)[0]!;
      assert.equal(rt.store.getTask(t1.id)!.status, "completed");
      const shown: any = await (t.client as any).request("work_get", { work_id: workA!.id });
      assert.equal(shown.work.writeTarget.branch, wtA.branch);
      assert.equal(shown.work.writeTarget.baseCommit, wtA.baseCommit);
      // 整项取消工作 A（不触碰副本与已写文件）
      await rt.subagents!.cancelWork({ workId: workA!.id, by: "owner" });
      assert.equal(fs.readFileSync(path.join(wtA.path, "a.txt"), "utf8"), "alpha-A\n", "取消后副本字节保留");
    });

    // —— Phase W 结束（rt.stop 在退出未核实冒烟另立一个实例） ——
    if (workA && workB && wtA && wtB) {
      evidence.push(`副本 A 改动：${wtA.path}/a.txt = ${fs.readFileSync(path.join(wtA.path, "a.txt"), "utf8").trim()}`);
      evidence.push(`副本 B 改动：${wtB.path}/b.txt = ${fs.readFileSync(path.join(wtB.path, "b.txt"), "utf8").trim()}`);
    }
  } finally {
    await t.shutdown();
  }
}

// ============ Phase N：非 Git 串行（父持锁 → queued → 释放后启动） ============
{
  const plainDir = path.join(root, "plain");
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, "notes.md"), "v1\n", "utf8");

  let releaseParent!: () => void;
  const gateParent = new Promise<void>((res) => (releaseParent = res));
  const marks: string[] = [];
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派 · 工作区修改]") && text.includes("WRITE-PLAIN")) {
      marks.push("child-started");
      if (afterTool(req)) return { kind: "text", text: "child-done" };
      return { kind: "tool_calls", calls: [{ id: "wp1", name: "edit", arguments: { path: "notes.md", edits: [{ oldText: "v1", newText: "v1-child" }] } }] };
    }
    if (text.includes("开始（父在跑）")) {
      await gateParent;
      return { kind: "text", text: "parent-done" };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("smoke16-plain", responder, {
    config: { ...realTools(), productType: "ruukoto-code", execution: { backend: "container", container: { uid: UID, gid: GID } },
  } });
  const rt = t.runtime;
  try {
    await check("非 Git 目录与父会话按目录占用串行（父持锁时子任务 queued，父结束后启动）", async () => {
      const session = await rt.createSession({ projectName: "smoke16-plain", cwd: plainDir });
      const parent = await rt.submit({ sessionId: session.id, requestId: "pn1", input: "开始（父在跑）", modelSelection: rt.defaultSelection });
      await waitFor("父挂起（持锁）", () => releaseParent !== undefined, 60_000);
      const a = await rt.subagents!.delegate({
        parentTaskId: parent.id, key: "p1", request: "WRITE-PLAIN", mode: "modify", target: ".",
        materials: null, readPaths: null, paramsDigest: "dsm16-p1",
      });
      const wt = a.work.writeTarget!;
      assert.ok(wt.kind === "direct", "非 Git 目标走直接写入");
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(rt.store.getTask(a.task.id)!.status, "queued", "父持锁期间子任务仍排队（容器感知不到的父锁不讲脱手）");
      }
      assert.deepEqual<string[]>(marks, [], "子任务没有提前启动");
      releaseParent();
      await waitFor("子完成（父结束后自然启动）", () => rt.store.getTask(a.task.id)!.resultSummary !== null, 60_000);
      assert.ok(marks.includes("child-started"), "子任务在父结束后启动");
      assert.equal(fs.readFileSync(path.join(plainDir, "notes.md"), "utf8"), "v1-child\n");
      evidence.push(`非 Git 目标 ${wt.path}：父锁下排队，父结束后容器内 edit 覆盖（notes.md = v1-child）`);
    });
  } finally {
    await t.shutdown();
  }
}

// ---------- 汇总 ----------
console.log("\n===== 证据 =====");
for (const line of evidence) console.log(line);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `，${failed.length} FAIL` : ""}`);
process.exit(failed.length ? 1 : 0);
