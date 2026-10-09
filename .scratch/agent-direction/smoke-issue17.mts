/**
 * agent-direction issue 17 真实容器冒烟：改动汇总（macOS Docker Desktop / Linux 原生 docker）。
 *
 * 用法：npx tsx .scratch/agent-direction/smoke-issue17.mts
 * 需要：docker 可用 + ruukoto-worker:latest 镜像存在。
 * Linux 原生 docker 下按宿主身份覆盖：RUUKOTO_CONTAINER_UID / RUUKOTO_CONTAINER_GID
 * （例如 tx 上 uid/gid 1003）。
 *
 * 真实范围（均经真实容器边界，模型为模拟）：
 * 1. 修改委派：宿主容器创建 worktree；子任务容器在其内真实 edit/write（副本与
 *    父工作区字节互不相干）；
 * 2. 汇总容器：add -N → diff → apply --check → apply 在容器内真实执行，改动
 *    落入父工作区待提交区，父 HEAD 不变，事件登记；
 * 3. 冲突：父同文件本地改动 → integrate_conflict 零写入、双方保留；
 * 4. 取消 + 关闭后的第二项工作仍可汇总（成果可找回）；
 * 5. 父仓库本身是 worktree 的目标：共享 Git 目录补挂读写，仍能汇总；
 * 6. 全程无 ruukoto-task-* 残余容器。
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  lastUserText,
  realTools,
  startTestRuntime,
  waitFor,
  type RecordedRequestLike,
} from "../../test/helpers/testkit.ts";
import { initGitRepo } from "../../test/helpers/git-fixture.ts";
import type { Responder } from "../../test/helpers/mock-provider.ts";

if (childProcess.execFileSync("docker", ["info"], { stdio: "pipe" }).length === 0) throw new Error("docker 不可用");

function afterTool(req: RecordedRequestLike): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
}

const checks: string[] = [];
const ok = (name: string) => {
  checks.push(name);
  console.log(`✔ ${name}`);
};
const gitOut = (cwd: string, args: string[]): string =>
  childProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const responder: Responder = async (req) => {
  const text = lastUserText(req);
  if (text.includes("[SubAgent 委派 · 工作区修改]")) {
    if (afterTool(req)) return { kind: "text", text: "child done" };
    if (text.includes("SMOKE-A"))
      return {
        kind: "tool_calls",
        calls: [
          { id: "sa", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "export const v = 1", newText: "export const v = 901" }] } },
        ],
      };
    if (text.includes("SMOKE-B"))
      return {
        kind: "tool_calls",
        calls: [
          { id: "sb", name: "write", arguments: { path: "src/b-new.md", content: "from copy B\n" } },
        ],
      };
    if (text.includes("SMOKE-WT"))
      return {
        kind: "tool_calls",
        calls: [
          { id: "sw", name: "edit", arguments: { path: "c.txt", edits: [{ oldText: "base\n", newText: "base + wt-parent\n" }] } },
        ],
      };
    return { kind: "text", text: "child done" };
  }
  return { kind: "text", text: "父回复" };
};

const t = await startTestRuntime("smoke17", responder, {
  config: { ...realTools(), execution: { backend: "container" } },
  workDirs: 1,
});
const containersLeft = (): string[] =>
  childProcess
    .execFileSync("docker", ["ps", "-a", "--filter", "name=ruukoto-task-", "--format", "{{.Names}}"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

try {
  const rt = t.runtime;
  console.log(`执行后端：${rt.config.execution?.backend}；平台：${os.platform()}；uid/gid=${process.env.RUUKOTO_CONTAINER_UID ?? 1000}/${process.env.RUUKOTO_CONTAINER_GID ?? 1000}`);

  // —— 1+2：委派、容器内改动、容器内汇总 ——
  fs.mkdirSync(path.join(t.work[0]!, "src"), { recursive: true });
  fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 1\n", "utf8");
  initGitRepo(t.work[0]!);
  const headBefore = gitOut(t.work[0]!, ["rev-parse", "HEAD"]);
  const session = await rt.createSession({ projectName: "smk", cwd: t.work[0]! });
  const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
  await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

  const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sa", request: "SMOKE-A 改 a", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "s17-a" });
  const b = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sb", request: "SMOKE-B 加新文件", mode: "modify", target: ".", materials: null, readPaths: null, paramsDigest: "s17-b" });
  await waitFor("A 完工", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
  await waitFor("B 完工", () => rt.store.getTask(b.task.id)!.resultSummary !== null);
  assert.ok(a.work.writeTarget!.kind === "worktree" && b.work.writeTarget!.kind === "worktree");
  const wtA = a.work.writeTarget!;
  const wtB = b.work.writeTarget!;
  assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 1\n", "副本创建与子任务改动不沾父工作区");
  assert.equal(fs.readFileSync(path.join(wtA.path, "src/a.ts"), "utf8"), "export const v = 901\n", "子任务容器真实改动副本");
  assert.ok(fs.existsSync(path.join(wtB.path, "src/b-new.md")), "子任务容器真实新增副本文件");
  assert.equal(gitOut(t.work[0]!, ["worktree", "list", "--porcelain"]).includes(wtA.path), true, "git worktree list 见副本（容器内创建）");
  ok("委派：副本由宿主容器创建、子任务容器真实 edit/write、父工作区字节不变");

  const ra = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
  const rb = await rt.subagents!.integrate({ workId: b.work.id, parentTaskId: parent.id, parentSessionId: session.id });
  assert.equal(ra.state, "applied");
  assert.equal(rb.state, "applied");
  assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 901\n");
  assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/b-new.md"), "utf8"), "from copy B\n");
  assert.equal(gitOut(t.work[0]!, ["rev-parse", "HEAD"]), headBefore, "不代提交：父 HEAD 不变");
  assert.equal(rt.store.hasIntegratedEvent(a.work.id) && rt.store.hasIntegratedEvent(b.work.id), true);
  ok("汇总：容器内 diff/apply 真实落入待提交区、父 HEAD 不变、事件登记");

  const rAgain = await rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id });
  assert.equal(rAgain.state, "already", "重复汇总幂等（完整差异已在工作区）");
  ok("幂等：already 不重复写入、不重复登记");

  // —— 3：冲突零写入 ——
  fs.writeFileSync(path.join(t.work[0]!, "src/a.ts"), "export const v = 901 // 拥有者本地\n", "utf8");
  // 同一副本上模拟继续委派产生新改动（汇总后副本继续变化 → 再汇总冲突）
  fs.writeFileSync(path.join(wtA.path, "src/a.ts"), "export const v = 902\n", "utf8");
  await assert.rejects(
    () => rt.subagents!.integrate({ workId: a.work.id, parentTaskId: parent.id, parentSessionId: session.id }),
    (e: any) => {
      assert.equal(e.code, "integrate_conflict");
      assert.match(e.message, /src\/a\.ts|保留/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(t.work[0]!, "src/a.ts"), "utf8"), "export const v = 901 // 拥有者本地\n", "父原改动不被覆盖");
  assert.equal(fs.readFileSync(path.join(wtA.path, "src/a.ts"), "utf8"), "export const v = 902\n", "副本成果保留");
  ok("冲突：零写入、点名文件、双方保留");

  // —— 4：取消 + 关闭后仍可汇总 ——
  await rt.subagents!.cancelWork({ workId: b.work.id, by: "owner" });
  rt.subagents!.close({ subAgentId: b.agent.id, by: "owner" });
  const rSalv = await rt.subagents!.integrate({ workId: b.work.id, parentTaskId: parent.id, parentSessionId: session.id });
  assert.equal(rSalv.state, "already", "已套用过的工作幂等返回");
  ok("取消 + 关闭：不拦汇总（幂等命中如实返回，成果保留）");

  // —— 5：父仓库本身是 worktree（共享 Git 目录在父工作区内、仓库根之外）——
  // 副本创建与汇总的补挂（issue 17）：macOS TMPDIR 的 /var→/private/var 别名会
  // 让 .git 指针字串与挂载路径不一致，夹具与真实流程一样统一用 realpath 建链
  fs.mkdirSync(path.join(t.dirs.root, "ws-second", "main"), { recursive: true });
  const ws2 = fs.realpathSync(path.join(t.dirs.root, "ws-second"));
  fs.writeFileSync(path.join(ws2, "main", "c.txt"), "base\n", "utf8");
  initGitRepo(path.join(ws2, "main"));
  childProcess.execFileSync("git", ["worktree", "add", path.join(ws2, "linked")], { cwd: path.join(ws2, "main") });
  const session2 = await rt.createSession({ projectName: "smk2", cwd: ws2 });
  const parent2 = await rt.submit({ sessionId: session2.id, requestId: "p2", input: "开始", modelSelection: rt.defaultSelection });
  await waitFor("父2完成", () => rt.store.getTask(parent2.id)!.status === "completed");
  const wtWork = await rt.subagents!.delegate({ parentTaskId: parent2.id, key: "sw", request: "SMOKE-WT 改 c", mode: "modify", target: "linked", materials: null, readPaths: null, paramsDigest: "s17-w" });
  await waitFor("WT 完工", () => rt.store.getTask(wtWork.task.id)!.resultSummary !== null);
  const wtTarget = wtWork.work.writeTarget!;
  assert.ok(wtTarget.kind === "worktree");
  assert.equal(fs.realpathSync(path.join(ws2, "main", ".git")), wtTarget.commonGitDir, "共享 Git 目录在父仓库根之外");
  const rw = await rt.subagents!.integrate({ workId: wtWork.work.id, parentTaskId: parent2.id, parentSessionId: session2.id });
  assert.equal(rw.state, "applied");
  assert.equal(fs.readFileSync(path.join(ws2, "linked", "c.txt"), "utf8"), "base + wt-parent\n");
  ok("父仓库本身是 worktree：共享 Git 目录补挂读写、副本创建与汇总照常");

  // —— 6：容器零残余 ——
  await waitFor("容器零残余", () => containersLeft().length === 0, 20_000);
  ok(`容器零残余（ruukoto-task-*）`);
} finally {
  await t.shutdown();
}
console.log(`\n冒烟通过：${checks.length}/${checks.length}`);
