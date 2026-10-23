import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { DirIdentityError, resolveDirIdentitySync, sameDirIdentity, verifyDirIdentity, verifyDirIdentitySync } from "@ruukoto/core/dir-identity.ts";
import { listWorkspaceFiles, readWorkspaceFile } from "@ruukoto/runtime/workspace-files.ts";
import { readWorkspaceGit } from "@ruukoto/runtime/workspace-git.ts";
import { realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

function fixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-directory-")));
  const root = path.join(parent, "work");
  fs.mkdirSync(root);
  return { parent, root, identity: resolveDirIdentitySync(root), close: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

for (const verify of [verifyDirIdentity, verifyDirIdentitySync]) test(`${verify.name}：旧设备号不使登记目录失效，返回当前身份`, async () => {
  const kit = fixture();
  try {
    const registered = { ...kit.identity, dev: kit.identity.dev + 1 };
    assert.deepEqual(await verify(registered), kit.identity);
    assert.equal(registered.dev, kit.identity.dev + 1, "不改写历史登记值");
  } finally { kit.close(); }
});

for (const verify of [verifyDirIdentity, verifyDirIdentitySync]) test(`${verify.name}：inode、真实路径、目录类型或存在状态变化仍拒绝`, async () => {
  const kit = fixture();
  try {
    const link = path.join(kit.parent, "link"), file = path.join(kit.parent, "file");
    fs.symlinkSync(kit.root, link); fs.writeFileSync(file, "正文");
    for (const identity of [
      { ...kit.identity, ino: kit.identity.ino + 1 },
      { ...kit.identity, cwdReal: link },
      { ...kit.identity, cwdReal: file },
      { ...kit.identity, cwdReal: path.join(kit.parent, "missing") },
    ]) await assert.rejects(async () => verify(identity), DirIdentityError);
    assert.equal(sameDirIdentity(kit.identity, { ...kit.identity, cwdReal: link }), true);
    assert.equal(sameDirIdentity(kit.identity, { ...kit.identity, cwdReal: link, dev: kit.identity.dev + 1 }), false, "不同路径的物理别名仍需同设备号");
  } finally { kit.close(); }
});

test("登记设备号过期时仍能枚举文件、读取正文和读取 Git", async () => {
  const kit = fixture();
  try {
    fs.writeFileSync(path.join(kit.root, "file.txt"), "真实正文");
    execFileSync("git", ["init", "-q", "-b", "main", kit.root]);
    const registered = { ...kit.identity, dev: kit.identity.dev + 1 };
    assert.ok((await listWorkspaceFiles("workspace", registered, "")).entries.some(entry => entry.name === "file.txt"));
    const preview = readWorkspaceFile("workspace", registered, "file.txt");
    assert.equal(Buffer.from(preview.data, "base64").toString(), "真实正文");
    assert.deepEqual((await readWorkspaceGit("workspace", registered)).repository, { head: null, commits: [], nextCursor: null });
  } finally { kit.close(); }
});

test("旧设备号会话可启动真实工具，占用和 LaunchSpec 使用当前设备号", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const kit = await startTestRuntime("directory-device", async request => {
    if (request.messages.some(message => message.role === "tool")) return { kind: "text", text: "读取完成" };
    await gate;
    return { kind: "tool_calls", calls: [{ id: "read-current", name: "read", arguments: { path: "file.txt" } }] };
  }, { workDirs: 1, config: realTools() });
  try {
    const runtime = kit.runtime, { session } = await runtime.openWorkspace({ cwd: kit.work[0] });
    fs.writeFileSync(path.join(kit.work[0], "file.txt"), "设备号变化后的正文");
    const current = resolveDirIdentitySync(kit.work[0]);
    runtime.store.withTx(() => {
      runtime.store.db.prepare("UPDATE sessions SET cwd_dev = ? WHERE id = ?").run(current.dev + 1, session.id);
      runtime.store.db.prepare("UPDATE projects SET root_dev = ? WHERE id = ?").run(current.dev + 1, session.projectId);
    });
    const task = await runtime.submit({ sessionId: session.id, requestId: "device-change", input: "读取 file.txt", modelSelection: runtime.defaultSelection });
    await waitFor("任务进入运行或报告失败", () => ["running", "failed"].includes(runtime.store.getTask(task.id)!.status));
    assert.equal(runtime.store.getTask(task.id)!.status, "running");
    assert.equal(runtime.store.listAllOccupancy().find(held => held.taskId === task.id)?.cwdDev, current.dev);
    runtime.store.withTx(() => runtime.store.releaseOccupancy(task.id));
    assert.equal(await runtime["acquireAgentResources"](runtime.store.getTask(task.id)!), true);
    assert.equal(runtime.store.listAllOccupancy().find(held => held.taskId === task.id)?.cwdDev, current.dev, "等待后重取占用也使用本次设备号");
    const stored = runtime.store.getSession(session.id)!;
    const router = (await runtime["getDriver"](stored))["router"];
    assert.ok(router);
    assert.deepEqual(router.launchSpecFor(runtime.store.getTask(task.id)!, stored).workspaceIdentity, { dev: current.dev, ino: current.ino });
    release();
    await waitFor("真实 read 结束", () => ["completed", "failed"].includes(runtime.store.getTask(task.id)!.status), 15_000);
    assert.equal(runtime.store.getTask(task.id)!.status, "completed");
    assert.ok(JSON.stringify(runtime.readHistory({ sessionId: session.id }).entries).includes("设备号变化后的正文"));
    assert.equal(runtime.store.getSession(session.id)!.cwdDev, current.dev + 1);
  } finally { release(); await kit.shutdown(); }
});
