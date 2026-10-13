import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Session, WorkDelegation } from "@ruukoto/core/types.ts";
import { WorkCopyManager, type WorkCopyExecutor } from "@ruukoto/runtime/work-copy.ts";
import { initGitRepo, runGitStep } from "./helpers/git-fixture.ts";

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-workflow-copy-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "value.txt"), "base\n");
  initGitRepo(repo);
  const stat = fs.statSync(repo);
  const session = { id: "source", cwdReal: repo, cwdDev: stat.dev, cwdIno: stat.ino } as Session;
  const calls: Parameters<WorkCopyExecutor>[0][] = [];
  const shell = promisify(execFile);
  const manager = new WorkCopyManager({ worktreeRoot: path.join(root, "copies"), protectedRoots: () => [], execute: async input => {
    calls.push(input);
    const result = await shell("/bin/sh", ["-c", input.command], { cwd: input.workspace });
    return { isError: false, content: result.stdout };
  } });
  const execution = { kind: "workflow-host" as const, taskId: "host-task" };
  const target = await manager.prepareWriteTarget(".", session, "modify", "completed-parent", execution, { gitOnly: true });
  if (target.kind !== "worktree") assert.fail("需要 Git 工作副本");
  const work = { id: "modify", writeTarget: target } as WorkDelegation;
  const input = { work, target, parentTaskId: "completed-parent", execution };
  return { root, repo, session, manager, calls, target, input, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("工作流非 Git 修改在创建副本或写入前拒绝，普通委派仍可直接写入", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-workflow-nongit-")));
  const stat = fs.statSync(root);
  const session = { cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino } as Session;
  let calls = 0;
  const copies = `${root}-copies`;
  const manager = new WorkCopyManager({ worktreeRoot: copies, protectedRoots: () => [], execute: async () => {
    calls++;
    return { isError: false, content: "" };
  } });
  try {
    await assert.rejects(manager.prepareWriteTarget(".", session, "workflow", "parent", undefined, { gitOnly: true }), { code: "git_required" });
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(root), []);
    const direct = await manager.prepareWriteTarget(".", session, "ordinary", "parent");
    assert.equal(direct.kind, "direct");
    assert.equal(fs.existsSync(copies), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("冻结补丁保留完整非 UTF-8 与二进制字节，验证副本按固定旧基线重建且写入独立", async () => {
  const f = await fixture();
  try {
    const text = Buffer.concat([Buffer.from("changed\n"), Buffer.from([0xff]), Buffer.alloc(70_000, 0x41)]);
    const binary = Buffer.from([0, 0xff, 0x37, 0]);
    fs.writeFileSync(path.join(f.target.path, "value.txt"), text);
    fs.writeFileSync(path.join(f.target.path, "binary.dat"), binary);
    const frozen = await f.manager.freeze(f.input);
    assert.ok(frozen.bytes > 70_000);
    assert.ok(frozen.patch.includes(Buffer.from([0xff])));
    fs.writeFileSync(path.join(f.repo, "new-head.txt"), "原仓库后来提交\n");
    runGitStep(f.repo, "git add new-head.txt");
    runGitStep(f.repo, "git commit -q -m later");
    const verification = await f.manager.prepareVerificationTarget({ ...f.input, frozen, parentSession: f.session, verificationWorkId: "verify" });
    assert.notEqual(verification.path, f.target.path);
    assert.equal(verification.baseCommit, frozen.baseCommit);
    assert.equal(fs.existsSync(path.join(verification.path, "new-head.txt")), false);
    assert.deepEqual(fs.readFileSync(path.join(verification.path, "value.txt")), text);
    assert.deepEqual(fs.readFileSync(path.join(verification.path, "binary.dat")), binary);
    fs.writeFileSync(path.join(verification.path, "value.txt"), "验证命令的输出\n");
    assert.deepEqual(fs.readFileSync(path.join(f.target.path, "value.txt")), text);
    const result = await f.manager.integrateFrozen({ ...f.input, frozen, parentSession: f.session });
    assert.equal(result.state, "applied");
    assert.deepEqual(fs.readFileSync(path.join(f.repo, "value.txt")), text);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, "binary.dat")), binary);
    assert.equal(fs.readFileSync(path.join(f.repo, "new-head.txt"), "utf8"), "原仓库后来提交\n");
    const checked = await f.manager.check({ ...f.input, command: "test -f new-head.txt && printf checked" });
    assert.equal(checked.content, "checked");
    assert.equal(f.calls.at(-1)!.workspace, f.repo);
    assert.ok(f.calls.every(call => call.execution?.taskId === "host-task" && call.parentTaskId === "completed-parent"));
    assert.ok(f.calls.filter(call => call.operation === "freeze" || call.operation === "verify").every(call =>
      call.extraGrants?.some(grant => grant.purpose === "冻结补丁的临时传输目录")));
  } finally { f.cleanup(); }
});

for (const change of ["改写", "新增", "删除"] as const) {
  test(`验证后${change}副本字节使旧冻结成果失效，目标零套用`, async () => {
    const f = await fixture();
    try {
      fs.writeFileSync(path.join(f.target.path, "value.txt"), "待验证成果\n");
      const frozen = await f.manager.freeze(f.input);
      await f.manager.prepareVerificationTarget({ ...f.input, frozen, parentSession: f.session, verificationWorkId: "verify" });
      if (change === "改写") fs.writeFileSync(path.join(f.target.path, "value.txt"), "新成果\n");
      if (change === "新增") fs.writeFileSync(path.join(f.target.path, "new.txt"), "新成果\n");
      if (change === "删除") fs.unlinkSync(path.join(f.target.path, "value.txt"));
      await assert.rejects(f.manager.integrateFrozen({ ...f.input, frozen, parentSession: f.session }), { code: "frozen_changed" });
      assert.equal(fs.readFileSync(path.join(f.repo, "value.txt"), "utf8"), "base\n");
      assert.equal(fs.existsSync(path.join(f.repo, "new.txt")), false);
    } finally { f.cleanup(); }
  });
}

test("冻结补丁与工作、基线或摘要不符在执行前拒绝，摘要自洽的伪造字节仍不能套用", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.target.path, "value.txt"), "result\n");
    const frozen = await f.manager.freeze(f.input);
    const count = f.calls.length;
    for (const altered of [{ ...frozen, workId: "other-work" }, { ...frozen, baseCommit: "0".repeat(40) },
      { ...frozen, digest: "0".repeat(64) }, { ...frozen, bytes: frozen.bytes + 1 }]) {
      await assert.rejects(f.manager.integrateFrozen({ ...f.input, frozen: altered, parentSession: f.session }), { code: "frozen_invalid" });
    }
    assert.equal(f.calls.length, count);
    const fake = Buffer.from(frozen.patch.toString().replace("+result", "+tamper"));
    const other = { ...frozen, patch: fake, bytes: fake.length, digest: createHash("sha256").update(fake).digest("hex") };
    await assert.rejects(f.manager.integrateFrozen({ ...f.input, frozen: other, parentSession: f.session }), { code: "frozen_changed" });
    assert.equal(fs.readFileSync(path.join(f.repo, "value.txt"), "utf8"), "base\n");
  } finally { f.cleanup(); }
});

test("空冻结成果可建立独立验证副本，汇总没有写入", async () => {
  const f = await fixture();
  try {
    const frozen = await f.manager.freeze(f.input);
    assert.equal(frozen.bytes, 0);
    const verification = await f.manager.prepareVerificationTarget({ ...f.input, frozen, parentSession: f.session, verificationWorkId: "verify-empty" });
    assert.equal(fs.readFileSync(path.join(verification.path, "value.txt"), "utf8"), "base\n");
    const result = await f.manager.integrateFrozen({ ...f.input, frozen, parentSession: f.session });
    assert.equal(result.state, "empty");
    assert.equal(fs.readFileSync(path.join(f.repo, "value.txt"), "utf8"), "base\n");
  } finally { f.cleanup(); }
});

test("冻结汇总幂等，冲突零套用且保留双方成果", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.target.path, "value.txt"), "result\n");
    const frozen = await f.manager.freeze(f.input);
    const applied = await f.manager.integrateFrozen({ ...f.input, frozen, parentSession: f.session });
    const already = await f.manager.integrateFrozen({ ...f.input, frozen, parentSession: f.session });
    assert.equal(applied.state, "applied");
    assert.equal(already.state, "already");
    fs.writeFileSync(path.join(f.repo, "value.txt"), "用户并发修改\n");
    const conflict = await f.manager.integrateFrozen({ ...f.input, frozen, parentSession: f.session });
    assert.equal(conflict.state, "conflict");
    assert.equal(fs.readFileSync(path.join(f.repo, "value.txt"), "utf8"), "用户并发修改\n");
    assert.equal(fs.readFileSync(path.join(f.target.path, "value.txt"), "utf8"), "result\n");
  } finally { f.cleanup(); }
});
