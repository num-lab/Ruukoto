import * as http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { startMockOneBot, MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET } from "./helpers/mock-onebot.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, SessionFailed, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalCommandDoc, PersonalCommandsDoc, personalCommandWork, resolvePersonalCommand, personalCommandConfiguration, personalCommandsFingerprint, type PersonalCommandRef } from "../apps/ruukoto/src/personal-command-work.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { capturePersonalScheduleScope, verifyPersonalScheduleScope } from "../apps/ruukoto/src/personal-schedule-scope.ts";
import { appendPersonalConfiguration, personalConfigurationVersions, personalConfigurationDigest, selectPersonalConfiguration, initializePersonalSettings, PersonalConfigurationDoc } from "../apps/ruukoto/src/personal-settings-records.ts";
import { withPersonalSettingsSession, dispatchPersonalConfiguration } from "../apps/ruukoto/src/personal-settings-operations.ts";
import { personalSettingsIdentity } from "../apps/ruukoto/src/personal-settings.ts";
import { savePersonalCommands } from "../apps/ruukoto/src/personal-command-config.ts";
import type { PersonalCommandConfig } from "../apps/ruukoto/src/personal-command-config.ts";
import { personalCommandFingerprint } from "../apps/ruukoto/src/personal-command-execution.ts";
import { PersonalWorkDoc, personalWorkResult, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalDelegationDoc, delegatePersonalAnalysis, listPersonalDelegations, personalDelegationProgress, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalReportResult } from "../apps/ruukoto/src/personal-report.ts";
import { personalServiceSourceBlocker } from "../apps/ruukoto/src/personal-service-operations.ts";
import type { ServiceManagerConfig } from "../apps/ruukoto/src/service-helper.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

// Note: 见 .agents/notes/implemented/testing/2026-10-24-test-suite-reduction.md
const context = BACKGROUND_CONTEXT;
const machineId = "a".repeat(32), bootId = "12345678-1234-1234-1234-123456789abc";
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待原命令事实超时"); await delay(10); }
}

async function fixture(t: TestContext, command = "echo x >> count", respond?: Responder) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-command-work-")));
  const workspace = path.join(root, "work"), directory = path.join(root, "profile"), groups = path.join(root, "groups");
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(groups, { mode: 0o700 });
  const { dev, ino } = fs.statSync(workspace);
  const commands: PersonalCommandConfig = { version: 1, workspace, identity: { dev, ino }, machineId, tmpdir: fs.realpathSync(os.tmpdir()) };
  const children = new Map<string, { child: childProcess.ChildProcess; group: string; disk: string; description: string }>();
  const descriptors = new Map<number, string>();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const realSpawn = childProcess.spawn, realExecFile = childProcess.execFile;
  const readFile = nodeFs.readFileSync, exists = nodeFs.existsSync, access = nodeFs.accessSync, open = nodeFs.openSync, stat = nodeFs.statSync, rename = nodeFs.renameSync;
  let stopFails = false, receiptFails = false, stopQueries = 0;
  const alive = (child: childProcess.ChildProcess) => child.exitCode === null && child.signalCode === null;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (target === "/etc/machine-id") return machineId + "\n";
    if (target === "/proc/sys/kernel/random/boot_id") return bootId + "\n";
    for (const value of children.values()) {
      if (target === `/proc/${value.child.pid}/stat`) {
        if (!alive(value.child)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return `${value.child.pid} (worker) ${["S", "1", String(value.child.pid), ...Array(16).fill("0"), "123"].join(" ")}`;
      }
      if (target === `/proc/${value.child.pid}/cgroup`) return `0::${value.group}\n`;
    }
    const match = /^\/proc\/self\/fd\/(\d+)\/cgroup.events$/.exec(String(target));
    if (match) return `populated ${alive(children.get(descriptors.get(Number(match[1]))!)!.child) ? 1 : 0}\n`;
    return readFile(target, options);
  });
  t.mock.method(nodeFs, "existsSync", (target: fs.PathLike) => {
    if (target === "/sys/fs/cgroup/cgroup.controllers") return true;
    if (target === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns") return false;
    return exists(target);
  });
  t.mock.method(nodeFs, "accessSync", (target: fs.PathLike, mode?: number) => {
    if (["/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl"].includes(String(target)) || String(target).endsWith("/cgroup.kill")) return;
    return access(target, mode);
  });
  t.mock.method(nodeFs, "statSync", (target: fs.PathLike, options?: fs.StatOptions) => stat([...children.values()].find(value => `/sys/fs/cgroup${value.group}` === target)?.disk ?? target, options));
  t.mock.method(nodeFs, "openSync", (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    for (const [scope, value] of children) if (target === `/sys/fs/cgroup${value.group}`) { const fd = open(value.disk, flags, mode); descriptors.set(fd, scope); return fd; }
    const match = /^\/proc\/self\/fd\/(\d+)\/cgroup.kill$/.exec(String(target));
    if (match) {
      const value = children.get(descriptors.get(Number(match[1]))!)!;
      if (alive(value.child)) process.kill(-value.child.pid!, "SIGKILL");
      return open(path.join(value.disk, "kill"), "w");
    }
    return open(target, flags, mode);
  });
  t.mock.method(nodeFs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (receiptFails && String(to).endsWith("/receipt.json")) throw Object.assign(new Error("receipt-failed"), { code: "EIO" });
    return rename(from, to);
  });
  t.mock.method(childProcess, "execFile", (file: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    if (file !== "/usr/bin/systemctl") return realExecFile(file, args, options, callback);
    if (args.includes("is-system-running")) callback(null, "running\n", "");
    else {
      stopQueries++;
      const value = children.get(args[2])!;
      callback(stopFails && !alive(value.child) ? new Error("query failed") : null,
        `LoadState=loaded\nActiveState=${alive(value.child) ? "active" : "inactive"}\nControlGroup=${value.group}\nInvocationID=${"c".repeat(32)}\nDescription=${value.description}\n`, "");
    }
    return new childProcess.ChildProcess();
  });
  t.mock.method(childProcess, "spawn", (file: string, args: string[], options: childProcess.SpawnOptions) => {
    if (file !== "/usr/bin/systemd-run") return realSpawn(file, args, options);
    const scope = args[args.indexOf("--unit") + 1], worker = args.at(-1)!;
    const child = realSpawn(process.execPath, [worker], { cwd: options.cwd ?? workspace, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const disk = path.join(groups, scope); fs.mkdirSync(disk, { mode: 0o700 });
    children.set(scope, { child, disk, group: `/user.slice/${scope}`, description: args.find(arg => arg.startsWith("Description="))!.slice("Description=".length) });
    const marker = new PassThrough(); child.stdio[4] = marker; setImmediate(() => marker.end("started\n"));
    return child;
  });
  syncBuiltinESMExports();
  const server = new MockModelServer(respond ?? (request => request.system?.includes("你是个人助手的子 Agent") && request.messages.at(-1)?.content === "执行命令"
    ? { kind: "tool_calls", calls: [{ id: "command", name: "run_command", arguments: { command } }] }
    : { kind: "text", text: "完成" }));
  const model: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_COMMAND_WORK_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[model.apiKeyEnv]; process.env[model.apiKeyEnv] = "test-only";
  const options = { directory, commands, provider: personalProvider(model), modelId: model.modelId };
  let personal: PersonalHarness | undefined;
  t.after(async () => {
    await personal?.close(); await server.close();
    for (const value of children.values()) if (alive(value.child)) process.kill(-value.child.pid!, "SIGKILL");
    t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", platform);
    if (previous === undefined) delete process.env[model.apiKeyEnv]; else process.env[model.apiKeyEnv] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, workspace, commands, server, provider: options.provider,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => personal = await openPersonalHarness({ ...options, ...overrides }),
    failStop: (value = true) => { stopFails = value; }, failReceipt: (value = true) => { receiptFails = value; },
    launches: () => children.size, stopQueries: () => stopQueries,
  };
}
const draft = (requestId: string, agentId?: PersonalWorkRef["agentId"]) => ({ requestId, sourceRequestId: "owner-source", content: "执行命令", ...(agentId ? { agentId } : {}) });
async function source(p: PersonalHarness) { await p.answer("拥有者委派来源", "owner-source"); }
async function original(p: PersonalHarness) { await until(async () => (await p.commands!.list()).items.length > 0); return (await p.commands!.list()).items[0].ref; }
async function unknown(p: PersonalHarness, ref: PersonalCommandRef) { await until(async () => { const value = await p.commands!.detail(ref, "stdout"); return value.result?.effect === "effect_unknown" && value.result.code !== "started"; }); }

for (const mode of ["confirm", "auto-review", "full_access"] as const) test(`durable 命令：${mode} 保留原权限、原生 owned Task 和双流分页，非零结果也释放身份`, async t => {
  const exitCode = mode === "confirm" ? 0 : 37;
  const f = await fixture(t, `head -c 7000 /dev/zero; printf '\\376err' >&2; echo x >> count; exit ${exitCode}`);
  let p = await f.open();
  await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = mode; }, context);
  await source(p);
  const readdir = nodeFs.readdirSync; let scans = 0;
  const scan = mode === "full_access" ? t.mock.method(nodeFs, "readdirSync", (...args: Parameters<typeof nodeFs.readdirSync>) => {
    if (String(args[0]) === f.directory) scans++;
    return Reflect.apply(readdir, nodeFs, args);
  }) : undefined;
  syncBuiltinESMExports();
  const work = await p.work.delegate(draft("run"));
  const command = await original(p);
  assert.equal((await p.harness.waitForTask(work.taskId, context)).state.outcome.status, "completed");
  if (scan) { scan.mock.restore(); syncBuiltinESMExports(); assert.equal(scans, 0); }
  const saved = (await p.harness.snapshot(PersonalCommandDoc, command.requestId, context))!.command!;
  const result = await p.harness.commit(tx => personalWorkResult(tx, work), context);
  assert.equal(result.commands?.[0]?.requiresVerification, false); assert.equal(result.commands?.[0]?.verifiedEffect, undefined);
  assert.match(result.commands![0].verification, /运行已返回且停止已核实/); assert.match(result.commands![0].verification, /不证明业务成功/);
  const request = f.server.calls.find(call => call.system?.includes("你是个人助手的子 Agent"))!;
  assert.match(JSON.stringify(request.tools), /run_command|read_command_output/);
  assert.ok(request.system?.includes(`当前工作命令权限：${{ confirm: "请求确认", "auto-review": "自动审查", full_access: "完全访问" }[mode]}。`));
  t.diagnostic(JSON.stringify({ mode, systemPrompt: Math.ceil(request.system!.length / 4), toolSchemas: Math.ceil(JSON.stringify(request.tools).length / 4) }));
  assert.equal(saved.started, true, JSON.stringify(await p.harness.commit(tx => tx.task(command.taskId), context)));
  assert.equal(saved.work.permission.mode, mode);
  assert.equal((await p.harness.commit(tx => tx.task(command.taskId), context))!.owner, work.taskId);
  assert.deepEqual((await p.commands!.detail(command, "stdout")).result, { effect: "returned", code: "command_returned", exitCode });
  const parts: Buffer[] = []; let offset = 0;
  do {
    const page = (await p.commands!.detail(command, "stdout", offset)).output!;
    assert.equal(page.complete, true); assert.equal(page.bytes, 7000);
    const part = Buffer.from(page.data, "base64"); assert.ok(part.length <= 3072); parts.push(part); offset = page.nextOffset ?? -1;
  } while (offset >= 0);
  assert.deepEqual(Buffer.concat(parts), Buffer.alloc(7000));
  assert.deepEqual(Buffer.from((await p.commands!.detail(command, "stderr")).output!.data, "base64"), Buffer.from([254, 101, 114, 114]));
  if (mode === "full_access") {
    await p.close(); p = await f.open();
    await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "confirm"; }, context);
  }
  await p.answer("新的拥有者来源", "reuse-source");
  const next = await p.work.delegate({ ...draft("reuse", work.agentId), sourceRequestId: "reuse-source", content: "继续分析" });
  await p.harness.waitForTask(next.taskId, context);
  if (mode === "full_access") {
    const reused = f.server.calls.findLast(call => call.system?.includes("你是个人助手的子 Agent"))!;
    assert.match(reused.system!, /当前工作命令权限：请求确认。/);
    assert.doesNotMatch(reused.system!, /当前工作命令权限：完全访问。/);
  }
  assert.equal(next.agentId, work.agentId); assert.equal(f.launches(), 1);
  assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
});

for (const mode of ["full_access"] as const) test(`durable 命令：${mode} 未知和取消跨重启保留占用，人工效果与原引用停止都核实后才复用`, async t => {
  const f = await fixture(t); f.failReceipt(); f.failStop();
  let p = await f.open();
  await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = mode; }, context);
  await source(p);
  const work = await p.work.delegate(draft("unknown")), ref = await original(p); await unknown(p, ref);
  assert.equal((await p.commands!.detail(ref, "stdout")).stopped, false);
  assert.equal((await p.harness.commit(tx => personalWorkResult(tx, work), context)).commands?.[0]?.requiresVerification, true);
  await assert.rejects(p.work.delegate(draft("other-member")), code("work_source_paused"));
  await assert.rejects(p.work.append(work, { requestId: "append", content: "继续执行", sourceRequestId: "owner-source" }), code("work_source_paused"));
  assert.equal(await p.answer("独立聊天", "independent"), "完成");
  const independent = await p.work.delegate({ ...draft("independent"), sourceRequestId: "independent", content: "继续分析" });
  await p.harness.waitForTask(independent.taskId, context);
  const competing = await p.work.delegate({ ...draft("competing-command"), sourceRequestId: "independent" });
  await p.harness.waitForTask(competing.taskId, context);
  assert.match(JSON.stringify(f.server.calls.at(-1)!.messages), /command_directory_busy/);
  assert.equal(f.launches(), 1); assert.equal((await p.commands!.list()).items.length, 1);
  await p.close(); const requests = f.server.calls.length; p = await f.open(); await unknown(p, ref);
  assert.equal(f.launches(), 1); assert.equal(f.server.calls.length, requests);
  assert.deepEqual((await p.commands!.list()).items[0].ref, ref);
  const canceled = p.work.cancel(work);
  await until(async () => (await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.cancelRequested);
  await p.harness.commit(tx => resolvePersonalCommand(tx, ref, "applied", "独立目录 count 只有原操作的一行"), context);
  await assert.rejects(p.harness.commit(tx => resolvePersonalCommand(tx, ref, "not_applied", "覆盖原说明"), context), code("command_resolution_invalid"));
  await delay(30);
  assert.deepEqual((await p.work.list()).find(agent => agent.id === work.agentId)!.work, work);
  assert.equal((await p.harness.commit(tx => tx.task(work.taskId), context))!.state.status, "running");
  assert.equal((await p.commands!.detail(ref, "stdout")).stopped, false);
  assert.equal((await p.harness.commit(tx => personalWorkResult(tx, work), context)).commands?.[0]?.requiresVerification, true);
  f.failStop(false); f.failReceipt(false);
  await p.harness.waitForTask(await p.commands!.stop(ref), context);
  assert.equal((await canceled).state.outcome.status, "aborted");
  const detail = await p.commands!.detail(ref, "stdout");
  assert.equal(detail.result!.effect, "effect_unknown"); assert.equal(detail.stopped, true);
  assert.equal(detail.resolution!.effect, "applied");
  const canceledResult = await p.harness.commit(tx => personalWorkResult(tx, work), context);
  assert.equal(canceledResult.state, "aborted"); assert.equal(canceledResult.commands?.[0]?.operation, ref.taskId);
  assert.equal(canceledResult.commands?.[0]?.requiresVerification, false); assert.equal(canceledResult.commands?.[0]?.verifiedEffect, "applied");
  const reused = await p.work.delegate({ ...draft("reuse", work.agentId), content: "继续分析" }); await p.harness.waitForTask(reused.taskId, context);
  assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
  assert.equal((await p.harness.commit(tx => personalWorkResult(tx, reused), context)).commands?.length ?? 0, 0);
});


test("durable 命令：首次启用拒绝未决旧工作，不恢复 provider 或补授旧工具", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, "", async request => {
    if (request.system?.includes("你是个人助手的子 Agent")) await gate;
    return { kind: "text", text: "完成" };
  });
  t.after(release);
  const p = await f.open({ commands: undefined }); await source(p);
  await p.work.delegate(draft("pending")); await until(() => f.server.calls.length === 2);
  await p.close(); const requests = f.server.calls.length;
  await assert.rejects(f.open(), code("command_config_pending"));
  assert.equal(f.server.calls.length, requests); assert.equal(f.launches(), 0);
});

for (const scenario of ["restricted", "full_access", "unproved-stop"] as const) test(`durable 命令：${scenario} 的独立损坏档案恢复拒绝，provider 与 OS 零新增调用`, async t => {
  const f = await fixture(t);
  if (scenario === "unproved-stop") { f.failReceipt(); f.failStop(); }
  const baseline = await f.open();
  if (scenario === "full_access") await baseline.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  await source(baseline);
  const work = await baseline.work.delegate(draft("invalid-proof")), ref = await original(baseline);
  if (scenario === "unproved-stop") await unknown(baseline, ref);
  else await baseline.harness.waitForTask(work.taskId, context);
  if (scenario === "restricted") await baseline.harness.waitForTask(await baseline.commands!.stop(ref), context);
  await baseline.close();
  const database = path.join(f.directory, "personal.sqlite"), snapshot = path.join(f.root, "baseline.sqlite");
  fs.copyFileSync(database, snapshot);
  const mutations = scenario === "restricted" ? ["admission", "permission", "claim", "worker", "mounts", "stop-task"] : scenario === "full_access" ? ["full-env", "full-mounts", "full-node"] : ["unproved-stop"];
  for (const mutation of mutations) await t.test(mutation, async () => {
    // 关闭后的基线每次独立复制回原路径，保留档案、workspace 与原命令的真实身份。
    fs.copyFileSync(snapshot, database);
    const p = await f.open();
    const saved = structuredClone((await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))!.command!);
    if (mutation === "admission") saved.admission = saved.startEntry!;
    else if (mutation === "claim") saved.directoryClaim = saved.admission;
    else if (mutation === "worker") {
      saved.prepared!.input.workerPath = path.join(f.root, "other-worker.mjs");
      saved.prepared!.input.runtimeReadRoots.push(saved.prepared!.input.workerPath);
    } else if (mutation === "mounts") saved.prepared!.input.mounts.push({ path: f.root, access: "read_write" });
    else if (mutation === "full-env") saved.prepared!.input.env = { TEST_VALUE: "must-not-persist" };
    else if (mutation === "full-mounts") saved.prepared!.input.mounts.push({ path: f.workspace, access: "read_write" });
    else if (mutation === "full-node") saved.prepared!.input.nodePath = "/bin/false";
    else if (mutation === "stop-task") saved.stopTask = work.taskId;
    else if (mutation === "unproved-stop") { saved.stopped = true; delete saved.observation; }
    const forgedPreparation = mutation === "worker" || mutation === "mounts" || mutation.startsWith("full-");
    if (forgedPreparation) saved.prepared!.fingerprint = personalCommandFingerprint(saved.command, saved.prepared!.spec, saved.prepared!.input);
    await p.harness.commit(async tx => {
      (await tx.doc(PersonalCommandDoc, ref.requestId, null)).command = saved;
      if (mutation === "permission") (await tx.doc(PersonalWorkDoc, work.requestId, null)).permission!.mode = "full_access";
    }, context);
    await p.close();
    if (forgedPreparation) {
      // 自算指纹与记录一致仍不能替代宿主钉定的 worker 和可见目录。
      const db = new DatabaseSync(database);
      try {
        db.prepare("UPDATE entries SET record = json_set(record, '$.data.prepared', json(?)) WHERE id = ?").run(JSON.stringify(saved.prepared), saved.startEntry!);
        db.prepare("UPDATE entries SET record = json_set(record, '$.data.fingerprint', ?) WHERE id = ?").run(saved.prepared!.fingerprint, saved.observation!);
      } finally { db.close(); }
    }
    const requests = f.server.calls.length;
    await assert.rejects(f.open(), code(mutation === "claim" ? "directory_claim_invalid" : "command_record_invalid"));
    assert.equal(f.server.calls.length, requests); assert.equal(f.launches(), 1);
  });
});

test("durable 命令：原接纳不能因任务和 document 一起丢失而静默消失", async t => {
  const f = await fixture(t); const p = await f.open(); await source(p);
  const work = await p.work.delegate(draft("orphan-admission")), ref = await original(p);
  await p.harness.waitForTask(work.taskId, context); await p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  try {
    db.prepare("DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind = ? AND json_extract(record, '$.key') = ?)").run(PersonalCommandDoc.definition.kind, ref.requestId);
    db.prepare("DELETE FROM documents WHERE kind = ? AND json_extract(record, '$.key') = ?").run(PersonalCommandDoc.definition.kind, ref.requestId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(ref.taskId);
    assert.equal(db.prepare("SELECT count(*) AS count FROM entries WHERE json_extract(record, '$.kind') = 'ruukoto.command-admission'").get()!.count, 1);
  } finally { db.close(); }
  const requests = f.server.calls.length;
  await assert.rejects(f.open(), code("command_record_invalid"));
  assert.equal(f.server.calls.length, requests); assert.equal(f.launches(), 1);
});

test("durable 命令：prepare认领提交后崩溃可恢复原准备，claim保留且实际命令只启动一次", async t => {
  const f = await fixture(t), cause = new Error("injected-after-prepare-claim-commit"); let injected = false;
  let p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => {
      const result = await commit(writes, context);
      if (!injected && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.directory-claim" && (write.value.data as { action?: string; owner?: { kind?: string } }).action === "acquire" && (write.value.data as { owner?: { kind?: string } }).owner?.kind === "command")) { injected = true; throw cause; }
      return result;
    };
    return storage;
  } });
  await source(p); const work = await p.work.delegate(draft("prepare-recovery"));
  await assert.rejects(p.harness.waitForTask(work.taskId, context), error => error === cause || error instanceof SessionFailed);
  assert.equal((await p.harness.closed).reason, "failed"); await p.close(); assert.equal(f.launches(), 0);
  p = await f.open(); await p.harness.waitForTask(work.taskId, context);
  assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
});

test("durable 命令：开始意图提交失败关闭 Harness，零 OS 派发", async t => {
  const f = await fixture(t); const cause = new Error("command-start-storage-failed");
  let tempDir = "";
  const p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = (writes, ctx) => {
      const start = writes.find(write => write.type === "entry" && write.value.kind === "ruukoto.command-start");
      if (start?.type === "entry") {
        const data = start.value.data as { prepared: { input: { tempDir: string } } };
        tempDir = data.prepared.input.tempDir; return Promise.reject(cause);
      }
      return commit(writes, ctx);
    };
    return storage;
  } });
  await source(p); const work = await p.work.delegate(draft("start-storage-failure"));
  await assert.rejects(p.harness.waitForTask(work.taskId, context), error => error === cause || error instanceof SessionFailed);
  assert.equal((await p.harness.closed).reason, "failed"); await p.close();
  assert.equal(f.launches(), 0); assert.equal(fs.existsSync(path.join(f.workspace, "count")), false);
  assert.ok(tempDir); assert.equal(fs.existsSync(tempDir), false);
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try {
    const tasks = await storage.scanTasks({ kind: "ruukoto.command" }, 8, undefined, context);
    assert.equal(tasks.items.length, 1);
    const entries = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, undefined, context);
    assert.equal(entries.items.filter(entry => entry.kind === "ruukoto.command-start").length, 0);
    assert.equal((await storage.scanEntries({ conversationId: work.agentId }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.command-admission").length, 1);
  } finally { await storage.close(context); }
});

test("durable 命令：回执已落盘而结果提交失败，重启读取原回执且不重发", async t => {
  const f = await fixture(t, "printf returned; echo x >> count; exit 23"), cause = new Error("command-result-storage-failed");
  let p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = (writes, ctx) => writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.command-observation") ? Promise.reject(cause) : commit(writes, ctx);
    return storage;
  } });
  await source(p); const work = await p.work.delegate(draft("result-storage-failure")), ref = await original(p);
  await assert.rejects(p.harness.waitForTask(work.taskId, context), error => error === cause || error instanceof SessionFailed);
  assert.equal((await p.harness.closed).reason, "failed"); await p.close();
  const records = fs.readdirSync(path.join(f.directory, "commands")).filter(name => name.startsWith("command-native_"));
  assert.equal(records.length, 1); assert.equal(fs.existsSync(path.join(f.directory, "commands", records[0], "receipt.json")), true);
  assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
  p = await f.open();
  assert.equal((await p.harness.waitForTask(work.taskId, context)).state.outcome.status, "completed");
  assert.deepEqual((await p.commands!.list()).items[0].ref, ref);
  const detail = await p.commands!.detail(ref, "stdout");
  assert.deepEqual(detail.result, { effect: "returned", code: "command_returned", exitCode: 23 });
  assert.equal(detail.stopped, true); assert.equal(Buffer.from(detail.output!.data, "base64").toString(), "returned");
  assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
});

for (const mode of ["full_access"] as const) test(`durable 命令：${mode} 未知暂停原源服务、主会话固定检查及委托全部成员，零 helper 外调`, async t => {
  let p!: PersonalHarness;
  let inspected = false;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const f = await fixture(t, "echo x >> count", async request => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (last?.role === "user" && last.content === "执行命令") return { kind: "tool_calls", calls: [{ id: "command", name: "run_command", arguments: { command: "echo x >> count" } }] };
      await waiting; return { kind: "text", text: "另一成员完成" };
    }
    if (last?.role === "user" && last.content === "委派并检查") return { kind: "tool_calls", calls: ["执行命令", "等待成员"].map((content, i) => ({ id: `member-${i}`, name: "background_work", arguments: { action: "delegate", content } })) };
    if (last?.role === "tool" && !inspected) {
      await unknown(p, await original(p));
      inspected = true;
      return { kind: "tool_calls", calls: [{ id: "inspection", name: "service_inspect", arguments: { unit: "personal-command-test.service" } }] };
    }
    return { kind: "text", text: String(last?.content) };
  });
  const helper = path.join(f.root, "helper"); fs.mkdirSync(path.join(helper, "units"), { recursive: true }); fs.mkdirSync(path.join(helper, "ops"));
  const helperPath = path.join(helper, "helper.mjs"), policyPath = path.join(helper, "services.json"), unit = "personal-command-test.service";
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), helperPath);
  fs.writeFileSync(policyPath, JSON.stringify({ machineId: "test-machine", inspectUid: 1, inspectGid: 1, services: { [unit]: { actions: ["restart"] } } }));
  fs.writeFileSync(path.join(helper, "units", unit), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify({ [unit]: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 123, invocationId: "before", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z", starts: 0 } }));
  const service: ServiceManagerConfig = { helperPath, policyPath, useSudo: false, sudoPath: "/usr/bin/sudo", timeouts: { inspectMs: 1000, restartMs: 1000, stopMs: 1000 } };
  f.failReceipt(); f.failStop(); p = await f.open({ service, serviceOperations: true });
  await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = mode; }, context);
  assert.match(await p.answer("委派并检查", "owner-source"), /work_source_paused/);
  const ref = await original(p), saved = (await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))!.command!;
  assert.deepEqual(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "owner-source"), context), { command: ref.requestId, admission: saved.admission });
  await assert.rejects(p.service!.request({ requestId: "service-bypass", sourceRequestId: "owner-source", unit, mode: "full_access" }), code("work_source_paused"));
  const group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const progress = await p.harness.commit(tx => personalDelegationProgress(tx, group), context);
  assert.equal(progress.paused, true); assert.equal(progress.members.length, 2);
  await p.answer("新的独立说明", "fresh-note");
  for (const [i, member] of progress.members.entries()) await assert.rejects(p.work.append(member.ref, { requestId: `append-${i}`, content: "继续执行", sourceRequestId: "fresh-note" }), code("work_source_paused"));
  await assert.rejects(p.harness.commit(async tx => delegatePersonalAnalysis(tx, (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).model!, { ...draft("continue-group"), sourceRequestId: "fresh-note", content: "续派成员" }, group), context), code("work_source_paused"));
  assert.equal(fs.existsSync(path.join(helper, "calls.log")), false); assert.equal((await p.inspections!.list()).length, 0);
  assert.equal(f.launches(), 1);
});

for (const stage of ["running", "unknown", "restored"] as const) test(`durable 命令：封组登记不等待命令 ${stage}，效果和停止核实后才唯一汇总`, async t => {
  let group!: PersonalDelegationRef;
  const command = "echo x >> count; while [ ! -f release ]; do sleep 0.01; done";
  const f = await fixture(t, command, request => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent")) return last?.role === "user" && last.content === "持住原命令"
      ? { kind: "tool_calls", calls: [{ id: "held-command", name: "run_command", arguments: { command } }] }
      : { kind: "text", text: "成员完成" };
    if (last?.role === "tool") return { kind: "text", text: String(last.content) };
    if (String(last?.content).startsWith("宿主委托汇总参考")) return { kind: "text", text: "完整命令汇总" };
    if (last?.role === "user" && last.content === "start") return { kind: "tool_calls", calls: [{ id: "member", name: "background_work", arguments: { action: "delegate", content: "持住原命令" } }] };
    if (last?.role === "user" && last.content === "report") return { kind: "tool_calls", calls: [{ id: "report", name: "background_work", arguments: { action: "report", delegation: group.entryId } }] };
    return { kind: "text", text: "完成" };
  });
  if (stage !== "running") { f.failReceipt(); f.failStop(); }
  let p = await f.open();
  const release = () => fs.writeFileSync(path.join(f.workspace, "release"), "继续\n");
  const summaryCalls = () => f.server.calls.filter(request => String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考"));
  try {
    await p.answer("start", "owner-source"); group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
    const ref = await original(p);
    await until(async () => !!(await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))?.command?.started && fs.existsSync(path.join(f.workspace, "count")));
    const started = (await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))!.command!;
    assert.deepEqual(started.result, { effect: "effect_unknown", code: "started" }); assert.equal(started.stopped, false);
    if (stage !== "running") {
      release(); await unknown(p, ref);
      if (stage === "restored") { await p.close(); p = await f.open(); await unknown(p, ref); }
    }
    assert.match(await p.answer("report", "report-source"), /report_registered/);
    const report = (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!;
    await until(async () => (await p.harness.commit(tx => tx.task(report.taskId), context))?.state.status === "waiting");
    assert.equal(report.delivery, "waiting"); assert.equal(summaryCalls().length, 0);
    assert.equal(await p.answer("独立聊天", "independent"), "完成");
    assert.match(await p.answer("report", "same-report"), /report_registered/);
    assert.equal((await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!.taskId, report.taskId);
    if (stage === "running") release();
    else {
      await assert.rejects(p.work.delegate({ requestId: "blocked-member", sourceRequestId: "owner-source", content: "不得新派" }), code("work_source_paused"));
      assert.equal((await p.commands!.detail(ref, "stdout")).stopped, false); assert.equal(summaryCalls().length, 0); assert.equal(f.launches(), 1);
      if (stage === "restored") {
        f.failStop(false); await p.harness.waitForTask(await p.commands!.stop(ref), context);
        assert.equal((await p.commands!.detail(ref, "stdout")).stopped, true); assert.equal(summaryCalls().length, 0);
        await assert.rejects(p.work.delegate({ requestId: "blocked-after-stop", sourceRequestId: "owner-source", content: "效果未核实不得新派" }), code("work_source_paused"));
        await p.harness.commit(tx => resolvePersonalCommand(tx, ref, "applied", "原 count 只有一行 x。"), context);
      } else {
        await p.harness.commit(tx => resolvePersonalCommand(tx, ref, "applied", "原 count 只有一行 x。"), context);
        await delay(30); assert.equal(summaryCalls().length, 0); assert.equal((await p.commands!.detail(ref, "stdout")).stopped, false);
        await assert.rejects(p.work.delegate({ requestId: "blocked-after-effect", sourceRequestId: "owner-source", content: "停止未核实不得新派" }), code("work_source_paused"));
        f.failStop(false); await p.harness.waitForTask(await p.commands!.stop(ref), context);
      }
    }
    assert.equal((await p.harness.waitForTask(report.taskId, context)).state.outcome.status, "completed");
    assert.deepEqual(await p.harness.commit(tx => personalReportResult(tx, group), context), { delivery: "local", state: "completed", text: "完整命令汇总", offset: 0, totalChars: 6 });
    assert.equal(summaryCalls().length, 1); assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
  } finally { release(); }
});

for (const mode of ["full_access"] as const) test(`durable 命令：${mode} 报告记录 command 暂停并跨重启观察原记录，效果和停止均核实才汇总`, async t => {
  let group!: PersonalDelegationRef;
  const f = await fixture(t, "echo x >> count", request => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent")) return last?.role === "user" && last.content === "报告前命令"
      ? { kind: "tool_calls", calls: [{ id: "command", name: "run_command", arguments: { command: "echo x >> count" } }] }
      : { kind: "text", text: "成员完成" };
    if (String(last?.content).startsWith("宿主委托汇总参考")) return { kind: "text", text: "完整命令汇总" };
    if (last?.role === "user" && last.content === "multi") return { kind: "tool_calls", calls: ["A", "B"].map(id => ({ id, name: "background_work", arguments: { action: "delegate", content: id } })) };
    if (last?.role === "user" && last.content === "report") return { kind: "tool_calls", calls: [{ id: "report", name: "background_work", arguments: { action: "report", delegation: group.entryId } }] };
    return { kind: "text", text: "完成" };
  });
  f.failReceipt(); f.failStop();
  let p!: PersonalHarness, command: PersonalCommandRef | undefined, armed = true;
  const provider = f.provider;
  p = await f.open({ provider: { ...provider, streamSimple: (model, input, options) => provider.streamSimple(model, input, { ...options, onPayload: async payload => {
    if (armed && JSON.stringify(input.messages.at(-1)).includes("宿主委托汇总参考")) {
      armed = false;
      await p.work.delegate({ requestId: "report-pause-command", sourceRequestId: "owner-source", content: "报告前命令" });
      command = await original(p); await unknown(p, command);
    }
    return await options?.onPayload?.(payload, model) ?? payload;
  } }) } });
  await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = mode; }, context);
  await p.answer("multi", "owner-source"); group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const members = (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.members;
  for (const member of members) await p.harness.waitForTask(member.taskId, context);
  await p.answer("report", "report-source");
  await until(async () => (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!.attempt === 1);
  assert.ok(command); const ref = command;
  const summaryCalls = () => f.server.calls.filter(request => String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考"));
  assert.equal(summaryCalls().length, 0);
  const report = (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!;
  assert.equal(report.pauses.length, 1);
  const pause = await p.harness.commit(tx => tx.entry(report.pauses[0]), context);
  assert.equal(pause!.kind, "ruukoto.report-pause");
  assert.deepEqual(pause!.data && typeof pause!.data === "object" && !Array.isArray(pause!.data) && pause!.data.blocker, { command: ref.requestId, admission: (await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))!.command!.admission });
  assert.equal(await p.answer("独立聊天", "independent"), "完成");
  await p.close(); p = await f.open();
  assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).paused, true);
  await p.harness.commit(tx => resolvePersonalCommand(tx, ref, "applied", "已从独立目录 count 核实原操作一行"), context);
  await delay(30); assert.equal(summaryCalls().length, 0); assert.equal((await p.commands!.detail(ref, "stdout")).stopped, false);
  f.failStop(false); await p.harness.waitForTask(await p.commands!.stop(ref), context);
  assert.equal((await p.harness.waitForTask(report.taskId, context)).state.outcome.status, "completed");
  assert.deepEqual(await p.harness.commit(tx => personalReportResult(tx, group), context), { delivery: "local", state: "completed", text: "完整命令汇总", offset: 0, totalChars: 6 });
  assert.equal(summaryCalls().length, 1); assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
  const work = (await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))!.command!.work.ref;
  await p.harness.waitForTask(work.taskId, context);
  const message = f.server.calls.filter(call => call.system?.includes("你是个人助手的子 Agent")).map(call => call.messages.at(-1)).findLast(message => message?.role === "tool" && String(message.content).startsWith("{") && JSON.parse(String(message.content)).operation === ref.taskId);
  assert.ok(message);
  const result = JSON.parse(String(message.content));
  assert.equal(result.effect, "effect_unknown"); assert.equal(result.verifiedEffect, "applied"); assert.equal(result.stopped, true);
  assert.match(result.next, /双事实已齐/); assert.match(result.next, /无需重复核实/);
  assert.equal(result.requiresVerification, false);
  for (const offset of [0, 4096]) {
    const current = await p.harness.commit(tx => personalWorkResult(tx, work, offset), context);
    assert.equal(current.commands?.[0]?.operation, ref.taskId); assert.equal(current.commands?.[0]?.requiresVerification, false);
    assert.equal(current.commands?.[0]?.verifiedEffect, "applied"); assert.equal(current.commands?.[0]?.stopped, true);
    assert.match(current.notice!, /优先于历史子回答/); assert.match(current.commands![0].verification, /双事实已齐/);
  }
});

test("durable 命令：在线 faulted 立即进入可核实状态，效果与原停止齐备前工作仍占用", async t => {
  const f = await fixture(t, "echo x >> count; printf started; sleep 30");
  f.failStop(); const p = await f.open(); await source(p);
  const work = await p.work.delegate(draft("online-fault")), ref = await original(p);
  await until(() => fs.existsSync(path.join(f.workspace, "count")));
  const task = await p.harness.commit(tx => tx.task(ref.taskId), context);
  assert.ok(task); assert.equal(task.state.status, "running");
  assert.equal((await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))!.command!.result!.code, "started");
  // SDK 的 Transaction.setTask 保留正常提交发布；只注入终态，不改原接纳、意图与 OS 绑定。
  await p.harness.commit(async tx => {
    const mutable = tx as typeof tx & { setTask(value: Extract<StorageWrite, { type: "task" }>["value"]): void };
    mutable.setTask({ ...task, memos: undefined, endedAt: Date.now(), state: { status: "terminal", outcome: { status: "faulted", error: { message: "injected-online-command-fault" } } } });
  }, context);
  const listed = (await p.commands!.list()).items[0];
  assert.deepEqual(listed.result, { effect: "effect_unknown", code: "interrupted" }); assert.equal(listed.stopped, false);
  const detail = await p.commands!.detail(ref, "stdout");
  assert.equal(detail.canResolve, true); assert.equal(detail.canRecheck, true); assert.equal(detail.stopped, false);
  assert.deepEqual(detail.result, listed.result);
  const canceled = p.work.cancel(work);
  await until(async () => (await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.cancelRequested);
  await p.harness.commit(tx => resolvePersonalCommand(tx, ref, "applied", "count 中已观察到原命令的一行"), context);
  await delay(30);
  assert.deepEqual((await p.work.list()).find(agent => agent.id === work.agentId)!.work, work);
  assert.equal((await p.commands!.detail(ref, "stdout")).stopped, false);
  await assert.rejects(p.work.closeAgent(work.agentId), code("subagent_busy"));
  assert.equal(await p.answer("独立聊天", "online-fault-chat"), "完成");
  f.failStop(false);
  await p.harness.waitForTask(await p.commands!.stop(ref), context);
  assert.equal((await canceled).state.outcome.status, "aborted");
  assert.equal((await p.commands!.detail(ref, "stdout")).stopped, true);
  assert.equal((await p.harness.commit(tx => tx.task(ref.taskId), context))!.state.outcome!.status, "faulted");
  const reused = await p.work.delegate({ ...draft("after-online-fault", work.agentId), content: "继续分析" }); await p.harness.waitForTask(reused.taskId, context);
  assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
});

test("命令权限提示：缺工作及读取失败覆盖旧完全访问说明，主会话不渲染子权限", async t => {
  const f = await fixture(t), p = await f.open(); await source(p);
  const work = await p.work.delegate({ ...draft("permission-render"), content: "继续分析" });
  await p.harness.waitForTask(work.taskId, context);
  const render = personalCommandWork(f.directory, f.commands).extension.sections![0].render;
  const input = { conversationId: work.agentId, agent: await p.main.agent(context), env: undefined, shown: { "command-permission": "当前工作命令权限：完全访问。" }, read: p.harness };
  assert.equal(await render(input, context), "当前工作命令权限无法核实，请结束本轮并报告拥有者。");
  t.mock.method(p.harness, "snapshot", async () => { throw new Error("read-failed"); });
  assert.equal(await render(input, context), "当前工作命令权限无法核实，请结束本轮并报告拥有者。");
  assert.equal(await render({ ...input, conversationId: ROOT_CONVERSATION_ID }, context), undefined);
});


async function commandIm(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, platform: "telegram" | "qq") {
  const bot = await startMockOneBot({}), sends: string[] = [];
  let loseSend = false;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { text: string; chat_id: string }; sends.push(body.text);
    if (loseSend) { loseSend = false; res.destroy(); return; }
    res.end(JSON.stringify({ ok: true, result: { message_id: 1000 + sends.length, chat: { id: Number(body.chat_id), type: "private" } } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const token = `${MOCK_QQ_ACCOUNT}:test-token`, env = { COMMAND_TEST_BOT: token, COMMAND_TEST_QQ: MOCK_QQ_SECRET }, previous = Object.keys(env).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "COMMAND_TEST_BOT", tokenDigest: createHash("sha256").update(token).digest("hex"), botId: MOCK_QQ_ACCOUNT, ownerId: "456", boundary: 0 };
  const qq = { version: 1 as const, enabled: true, generation: randomUUID(), endpoint: bot.url, tokenEnv: "COMMAND_TEST_QQ", tokenDigest: createHash("sha256").update(MOCK_QQ_SECRET).digest("hex"), botId: MOCK_QQ_ACCOUNT, ownerId: "456", boundary: 0, boundaryMessageId: "0" };
  let p: PersonalHarness, controller: AbortController | undefined, poll: Promise<void> | undefined, id = 0;
  const close = async () => { controller?.abort(); await poll; await p?.close(); };
  t.after(async () => { await close(); await bot.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const open = async () => {
    p = await f.open({ telegram, qq }); controller = new AbortController(); poll = p.qq.poll(controller.signal);
    await until(async () => (await p.qq.status()).online); return p;
  };
  const receive = async (text: string, replyTo?: number, from: "telegram" | "qq" = platform, extra: Record<string, unknown> = {}) => {
    const messageId = ++id;
    const update = { update_id: messageId, message: { message_id: messageId, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: Number(MOCK_QQ_ACCOUNT), is_bot: true } } }), ...extra } };
    const event = { post_type: "message", message_type: "private", sub_type: "friend", self_id: Number(MOCK_QQ_ACCOUNT), user_id: 456, message_id: messageId, time: 20, message: [...(replyTo === undefined ? [] : [{ type: "reply", data: { id: String(replyTo) } }]), { type: "text", data: { text } }], ...extra };
    const replay = () => from === "telegram" ? p.telegram.receive(update) : p.qq.receive(event);
    await replay();
    const key = `${from}:${MOCK_QQ_ACCOUNT}:456:${messageId}`;
    const received = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p.harness.waitForTask(received.taskId, context);
    return { key, value: (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!, messageId, replay };
  };
  return { open, close, receive, sends, telegram, qq, nextKey: () => `${platform}:${MOCK_QQ_ACCOUNT}:456:${id + 1}`, lose: () => { loseSend = true; } };
}

for (const platform of ["telegram", "qq"] as const) test(`命令菜单：${platform} 原入口核实、分页、旧菜单/跨平台拒绝、重投和重开不重发`, async t => {
  const f = await fixture(t, "printf '原输出'; head -c 7000 /dev/zero; printf '原错误' >&2; echo x >> count"), im = await commandIm(t, f, platform); let p = await im.open();
  f.failReceipt(); f.failStop();
  const source = await im.receive("请安排命令");
  await p.work.delegate({ requestId: "im-command", sourceRequestId: source.key, content: "执行命令" }); const ref = await original(p); await unknown(p, ref);
  const before = f.server.calls.length, list = await im.receive("/命令"), detail = await im.receive("命令1", Number(list.value.platformMessageId));
  assert.match(detail.value.reply!, /业务效果未知/); assert.match(detail.value.reply!, /原命令/);
  for (const action of ["查看命令输出", "查看命令错误"]) assert.match((await im.receive(action, Number(detail.value.platformMessageId))).value.reply!, /原输出|原错误/);
  let output = await im.receive("查看命令输出", Number(detail.value.platformMessageId)), pages = 1;
  while (output.value.selection?.kind === "command" && output.value.selection.nextOffset !== undefined) { output = await im.receive("下一页命令记录", Number(output.value.platformMessageId)); pages++; }
  assert.equal(pages, 3);
  assert.equal((await im.receive("命令确认已生效", Number(list.value.platformMessageId))).value.commandResolution, undefined);
  assert.equal((await im.receive("命令确认已生效", Number(detail.value.platformMessageId), platform === "qq" ? "telegram" : "qq")).value.commandResolution, undefined);
  if (platform === "telegram") assert.equal((await im.receive("命令确认已生效", Number(detail.value.platformMessageId), platform, { forward_origin: { type: "user" } })).value.commandResolution, undefined);
  const confirm = await im.receive("命令确认已生效", Number(detail.value.platformMessageId));
  if (platform === "telegram") im.lose();
  const saved = await im.receive("命令核实说明 原计数只有一行", Number(confirm.value.platformMessageId));
  if (platform === "telegram") assert.equal(saved.value.delivery, "effect_unknown");
  const sends = im.sends.length; await saved.replay(); assert.equal(im.sends.length, sends);
  assert.equal((await im.receive("命令核实说明 重复证据不能覆盖", Number(confirm.value.platformMessageId))).value.commandResolution, undefined);
  assert.equal((await p.harness.snapshot(PersonalCommandDoc, ref.requestId, context))!.command!.resolution!.actor, saved.key);
  assert.match((await im.receive("刷新命令", Number(detail.value.platformMessageId))).value.reply!, /原计数只有一行/);
  assert.equal(f.server.calls.length, before);
  await im.close(); p = await im.open();
  f.failStop(false);
  const after = await im.receive("命令1", Number((await im.receive("/命令")).value.platformMessageId));
  const stop = await im.receive("核实命令停止", Number(after.value.platformMessageId));
  await p.harness.waitForTask(stop.value.commandStop!.taskId, context);
  assert.equal((await p.commands!.detail(ref, "stdout")).stopped, true);
  assert.equal(f.launches(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
  await im.close(); p = await im.open(); assert.equal(f.launches(), 1); await im.close();
});

test("命令停止菜单：接纳后入口换代，执行前拒绝旧控制且不重复查询外部单元", async t => {
  const f = await fixture(t), im = await commandIm(t, f, "telegram"), p = await im.open(); f.failReceipt(); f.failStop();
  const source = await im.receive("安排命令"); await p.work.delegate({ requestId: "entry-change", sourceRequestId: source.key, content: "执行命令" }); const ref = await original(p); await unknown(p, ref);
  const list = await im.receive("/命令"), detail = await im.receive("命令1", Number(list.value.platformMessageId));
  const commit = p.harness.commit.bind(p.harness), expected = im.nextKey(), before = f.stopQueries();
  t.mock.method(p.harness, "commit", (fn: Parameters<PersonalHarness["harness"]["commit"]>[0], taskContext: Parameters<PersonalHarness["harness"]["commit"]>[1]) => commit(async tx => {
    const result = await fn(tx);
    const actor = (await tx.doc(PersonalTelegramReceiptDoc, expected, null)).receipt;
    if (actor?.commandStop) (await tx.doc(PersonalTelegramDoc)).config!.generation = "changed-before-stop";
    return result;
  }, taskContext));
  const stop = await im.receive("核实命令停止", Number(detail.value.platformMessageId)); await p.harness.waitForTask(stop.value.commandStop!.taskId, context);
  t.mock.restoreAll();
  assert.equal(f.stopQueries(), before); assert.equal((await p.commands!.detail(ref, "stdout")).stopped, false); assert.equal(f.launches(), 1);
  await im.close();
});


for (const corruption of ["marker", "resolution-actor", "resolution-receipt", "stop-actor", "stop-admission"] as const) test(`命令控制恢复：${corruption} 断链拒绝，零新增模型与命令执行`, async t => {
  const f = await fixture(t), im = await commandIm(t, f, "telegram"); let p = await im.open(); f.failReceipt();
  const source = await im.receive("安排命令"); await p.work.delegate({ requestId: "corrupt-control", sourceRequestId: source.key, content: "执行命令" }); const ref = await original(p); await unknown(p, ref);
  const list = await im.receive("/命令"), detail = await im.receive("命令1", Number(list.value.platformMessageId)), confirmation = await im.receive("命令确认已生效", Number(detail.value.platformMessageId));
  const resolution = await im.receive("命令核实说明 原结果已核实", Number(confirmation.value.platformMessageId));
  const stop = await im.receive("核实命令停止", Number(detail.value.platformMessageId)); await p.harness.waitForTask(stop.value.commandStop!.taskId, context);
  await p.harness.commit(async tx => {
    if (corruption === "marker") { const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== "personal-owner-controls"); }
    else if (corruption === "resolution-actor") (await tx.doc(PersonalCommandDoc, ref.requestId, null)).command!.resolution!.actor = "missing-receipt";
    else if (corruption === "resolution-receipt") delete (await tx.doc(PersonalTelegramReceiptDoc, resolution.key, null)).receipt!.commandResolution;
  }, context);
  await im.close();
  if (corruption === "stop-actor" || corruption === "stop-admission") {
    const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
    try { db.prepare("UPDATE tasks SET record = json_set(record, ?, ?) WHERE id = ?").run(corruption === "stop-actor" ? "$.input.controlRequestId" : "$.input.admission", corruption === "stop-actor" ? "missing-receipt" : -1, stop.value.commandStop!.taskId); } finally { db.close(); }
  }
  const before = f.server.calls.length;
  await assert.rejects(im.open(), error => error instanceof PersonalError && ["command_control_invalid", "command_record_invalid"].includes(error.code));
  assert.equal(f.server.calls.length, before); assert.equal(f.launches(), 1);
});


for (const initial of ["file", "host"] as const) test(`命令配置切换：${initial} 新目录只接新执行，旧目录消失后终态历史仍可重开且不再停止旧执行`, async t => {
  const f = await fixture(t, "pwd");
  if (initial === "file") { const lock = lockPersonalProfile(f.directory); fs.writeFileSync(path.join(f.directory, "command.json"), JSON.stringify(f.commands) + "\n", { mode: 0o600 }); lock.release(); }
  let p = await f.open();
  await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  await source(p);
  const work = await p.work.delegate(draft("old-directory"));
  const ref = await original(p); await p.harness.waitForTask(work.taskId, context);
  const oldOutput = await p.commands!.detail(ref, "stdout");
  assert.equal(Buffer.from(oldOutput.output!.data, "base64").toString().trim(), f.workspace);
  const workspace = path.join(f.root, "next-work"); fs.mkdirSync(workspace);
  const { dev, ino } = fs.statSync(workspace), next = { ...f.commands, workspace, identity: { dev, ino } };
  const content = JSON.stringify(next) + "\n", revision = personalConfigurationDigest(content), version = "next-command-directory";
  await p.harness.commit(async tx => {
    const previous = (await personalConfigurationVersions(tx, "commands")).at(-1)!;
    await appendPersonalConfiguration(tx, { target: "commands", version, revision, previousRevision: previous.revision, previousVersion: previous.version, config: next, content });
  }, context);
  fs.writeFileSync(path.join(f.directory, "command.json"), content, { mode: 0o600 });
  assert.deepEqual(await p.updateCommands(next, version, revision), { effectiveRevision: revision, code: "active", relatedOperations: [] });
  assert.deepEqual(await p.harness.commit(tx => personalCommandConfiguration(tx, undefined, next), context), f.commands);
  await p.harness.commit(tx => selectPersonalConfiguration(tx, "commands", "*", version), context);
  fs.writeFileSync(path.join(f.directory, "command.json"), content, { mode: 0o600 });
  await p.answer("新来源", "new-source");
  const nextWork = await p.work.delegate({ ...draft("new-directory"), sourceRequestId: "new-source" });
  await p.harness.waitForTask(nextWork.taskId, context);
  const newest = (await p.commands!.list()).items[0].ref;
  assert.equal(Buffer.from((await p.commands!.detail(newest, "stdout")).output!.data, "base64").toString().trim(), workspace);
  await p.close(); fs.rmSync(f.workspace, { recursive: true });
  const stops = f.stopQueries(); p = await f.open();
  assert.deepEqual((await p.commands!.detail(ref, "stdout")).result, oldOutput.result);
  assert.equal(f.stopQueries(), stops);
});


test("命令配置切换：原未知命令只阻止命令生效，独立聊天继续", async t => {
  const f = await fixture(t); f.failReceipt(); f.failStop();
  const lock = lockPersonalProfile(f.directory);
  fs.writeFileSync(path.join(f.directory, "command.json"), JSON.stringify(f.commands) + "\n", { mode: 0o600 }); lock.release();
  const p = await f.open(); await source(p);
  await p.work.delegate(draft("pending-migration")); const ref = await original(p); await unknown(p, ref);
  const workspace = path.join(f.root, "next-work"); fs.mkdirSync(workspace);
  const { dev, ino } = fs.statSync(workspace), next = { ...f.commands, workspace, identity: { dev, ino } };
  const baseline = (await p.harness.commit(tx => personalConfigurationVersions(tx, "commands"), context))[0];
  assert.equal((await p.updateCommands(f.commands, baseline.version, baseline.revision)).code, "active");
  const result = await p.updateCommands(next, "unpublished", "sha256:" + "a".repeat(64));
  assert.equal(result.code, "commands_busy"); assert.ok(result.relatedOperations.some(value => value.kind === "command" && value.id === ref.requestId));
  assert.equal(await p.answer("不依赖命令的聊天", "independent-migration"), "完成");
  assert.equal(f.launches(), 1);
});


test("命令配置切换：旧模型响应不改用新目录，新请求选择新版本", async t => {
  let release!: () => void, entered = false, first = true;
  const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, "pwd", async request => {
    if (request.system?.includes("你是个人助手的子 Agent") && request.messages.at(-1)?.role === "user") {
      if (first) { first = false; entered = true; await waiting; }
      return { kind: "tool_calls", calls: [{ id: "command", name: "run_command", arguments: { command: "pwd" } }] };
    }
    return { kind: "text", text: "完成" };
  });
  const lock = lockPersonalProfile(f.directory); fs.writeFileSync(path.join(f.directory, "command.json"), JSON.stringify(f.commands) + "\n", { mode: 0o600 }); lock.release();
  const p = await f.open(); await source(p); const work = await p.work.delegate(draft("old-response")); await until(() => entered);
  const workspace = path.join(f.root, "next-work"); fs.mkdirSync(workspace);
  const { dev, ino } = fs.statSync(workspace), next = { ...f.commands, workspace, identity: { dev, ino } }, content = JSON.stringify(next) + "\n", revision = personalConfigurationDigest(content), version = "changed-during-request";
  await p.harness.commit(async tx => {
    const previous = (await personalConfigurationVersions(tx, "commands")).at(-1)!;
    await appendPersonalConfiguration(tx, { target: "commands", version, revision, previousRevision: previous.revision, previousVersion: previous.version, config: next, content });
  }, context);
  fs.writeFileSync(path.join(f.directory, "command.json"), content, { mode: 0o600 });
  assert.equal((await p.updateCommands(next, version, revision)).code, "active");
  await p.harness.commit(tx => selectPersonalConfiguration(tx, "commands", "*", version), context);
  release(); await p.harness.waitForTask(work.taskId, context);
  assert.equal(f.launches(), 0); assert.match(JSON.stringify(f.server.calls.at(-1)!.messages), /execution_configuration_changed/);
  await p.answer("新来源", "new-response-source");
  const follow = await p.work.delegate({ ...draft("new-response"), sourceRequestId: "new-response-source" }); await p.harness.waitForTask(follow.taskId, context);
  assert.equal(f.launches(), 1);
});

for (const initial of ["existing", "first"] as const) test(`命令配置切换：${initial} 发布后回执前崩溃，冷启不把模块候选当成缺失配置`, async t => {
  const f = await fixture(t);
  if (initial === "existing") { const lock = lockPersonalProfile(f.directory); fs.writeFileSync(path.join(f.directory, "command.json"), JSON.stringify(f.commands) + "\n", { mode: 0o600 }); lock.release(); }
  const overrides = initial === "first" ? { commands: undefined } : {};
  let p = await f.open(overrides);
  const workspace = path.join(f.root, "next-work"); fs.mkdirSync(workspace);
  const { dev, ino } = fs.statSync(workspace), next = { ...f.commands, workspace, identity: { dev, ino } }, content = JSON.stringify(next) + "\n", revision = personalConfigurationDigest(content), version = "saved-before-publication-receipt";
  const previous = (await p.harness.commit(tx => personalConfigurationVersions(tx, "commands"), context)).at(-1)!;
  await p.harness.commit(tx => appendPersonalConfiguration(tx, { target: "commands", version, revision, previousRevision: previous.revision, previousVersion: previous.version, config: next, content }), context);
  fs.writeFileSync(path.join(f.directory, "command.json"), content, { mode: 0o600 });
  assert.equal((await p.updateCommands(next, version, revision)).code, "active");
  await p.close(); p = await f.open(overrides);
  if (initial === "existing") assert.equal((await p.harness.snapshot(PersonalCommandsDoc, context))?.configVersion, previous.version);
  assert.equal((await p.updateCommands(next, version, revision)).code, "active");
  assert.equal(f.launches(), 0);
});


test("命令配置切换：目录改回仍不恢复旧计划范围", async t => {
  const f = await fixture(t);
  const lock = lockPersonalProfile(f.directory); fs.writeFileSync(path.join(f.directory, "command.json"), JSON.stringify(f.commands) + "\n", { mode: 0o600 }); lock.release();
  const p = await f.open(), scope = await p.harness.commit(tx => capturePersonalScheduleScope(tx), context);
  const workspace = path.join(f.root, "next-work"); fs.mkdirSync(workspace); const { dev, ino } = fs.statSync(workspace);
  for (const [version, config] of [["changed-directory", { ...f.commands, workspace, identity: { dev, ino } }], ["returned-directory", f.commands]] as const) {
    const content = JSON.stringify(config) + "\n", revision = personalConfigurationDigest(content);
    await p.harness.commit(async tx => {
      const previous = (await personalConfigurationVersions(tx, "commands")).at(-1)!;
      await appendPersonalConfiguration(tx, { target: "commands", version, revision, previousRevision: previous.revision, previousVersion: previous.version, config, content });
    }, context);
    fs.writeFileSync(path.join(f.directory, "command.json"), content, { mode: 0o600 });
    assert.equal((await p.updateCommands(config, version, revision)).code, "active");
  }
  await assert.rejects(p.harness.commit(tx => verifyPersonalScheduleScope(tx, scope), context), code("schedule_scope_changed"));
});


test("命令配置切换：首次候选撤回到未启用，null文件与冷启动均不重新装配工具", async t => {
  const f = await fixture(t); let p = await f.open();
  assert.ok(p.commands); assert.ok(p.background);
  const content = "null\n", revision = personalConfigurationDigest(content), version = "withdraw-first-command";
  await p.harness.commit(async tx => {
    const previous = (await personalConfigurationVersions(tx, "commands")).at(-1)!;
    await appendPersonalConfiguration(tx, { target: "commands", version, revision, previousRevision: previous.revision, previousVersion: previous.version, config: null, content });
  }, context);
  fs.writeFileSync(path.join(f.directory, "command.json"), content, { mode: 0o600 });
  assert.equal((await p.updateCommands(null, version, revision)).code, "active");
  await p.harness.commit(tx => selectPersonalConfiguration(tx, "commands", "*", version), context);
  fs.writeFileSync(path.join(f.directory, "command.json"), content, { mode: 0o600 });
  assert.equal(p.commands, undefined); assert.equal(p.background, undefined);
  await p.close(); p = await f.open();
  assert.equal(p.commands, undefined); assert.equal(p.background, undefined);
  assert.equal((await p.main.agent(context)).tools.some(tool => tool.name === "run_command" || tool.name === "process_start"), false);
  const restoredContent = JSON.stringify(f.commands) + "\n", restoredRevision = personalConfigurationDigest(restoredContent), restoredVersion = "enable-after-command-withdrawal";
  await p.harness.commit(tx => appendPersonalConfiguration(tx, { target: "commands", version: restoredVersion, revision: restoredRevision, previousRevision: revision, previousVersion: version, config: f.commands, content: restoredContent }), context);
  fs.writeFileSync(path.join(f.directory, "command.json"), restoredContent, { mode: 0o600 });
  assert.equal((await p.updateCommands(f.commands, restoredVersion, restoredRevision)).code, "active");
  await p.harness.commit(tx => selectPersonalConfiguration(tx, "commands", "*", restoredVersion), context);
  fs.writeFileSync(path.join(f.directory, "command.json"), restoredContent, { mode: 0o600 });
  await p.close(); p = await f.open(); assert.ok(p.commands); assert.ok(p.background);
});


test("命令配置切换：离线旧宿主基线未记录时保存前拒绝，原宿主核实后仍可迁移", async t => {
  const f = await fixture(t), profile = lockPersonalProfile(f.directory);
  try {
    await withPersonalSettingsSession({ profile }, async session => {
      await initializePersonalSettings(profile, session);
      await session.commit(async tx => { (await tx.doc(PersonalCommandsDoc)).fingerprint = personalCommandsFingerprint(f.commands); }, context);
    });
    await assert.rejects(savePersonalCommands(profile, f.commands), code("command_config_baseline_missing"));
    assert.equal(fs.existsSync(path.join(f.directory, "command.json")), false);
    await withPersonalSettingsSession({ profile }, async session => {
      assert.equal((await session.commit(tx => personalConfigurationVersions(tx, "commands"), context)).length, 1);
      assert.deepEqual((await session.snapshot(PersonalConfigurationDoc, context))?.operations, []);
    });
  } finally { profile.release(); }
  const p = await f.open();
  const versions = await p.harness.commit(tx => personalConfigurationVersions(tx, "commands"), context);
  assert.equal(versions[1].origin, "host"); assert.equal(versions[1].revision, "missing"); assert.equal(versions[1].content, null);
  assert.deepEqual(await p.harness.commit(tx => personalCommandConfiguration(tx, undefined, f.commands), context), f.commands);
});


test("命令配置切换：宿主原配置可撤回等待中的目录迁移，原missing基线保持真实", async t => {
  const f = await fixture(t); f.failReceipt(); f.failStop();
  const profile = lockPersonalProfile(f.directory);
  const p = await openPersonalHarness({ profile, commands: f.commands, provider: f.provider, modelId: "mock-model" });
  try {
    await source(p); await p.work.delegate(draft("host-withdraw-pending")); const ref = await original(p); await unknown(p, ref);
    const workspace = path.join(f.root, "next-work"); fs.mkdirSync(workspace); const { dev, ino } = fs.statSync(workspace);
    const next = { ...f.commands, workspace, identity: { dev, ino } }, current = { profile, instance: p }, identity = personalSettingsIdentity(profile);
    const saved = await dispatchPersonalConfiguration(current, { v: 2, id: randomUUID(), profile: identity, expectedRevision: "missing", op: { kind: "config.save", target: "commands", value: next } });
    assert.equal(saved?.status, "waiting");
    const withdrawn = await dispatchPersonalConfiguration(current, { v: 2, id: randomUUID(), profile: identity, expectedRevision: saved!.savedRevision, op: { kind: "settings.withdraw", id: saved!.id } });
    assert.ok(withdrawn && ["waiting", "active"].includes(withdrawn.status));
    assert.equal(fs.readFileSync(path.join(f.directory, "command.json"), "utf8"), JSON.stringify(f.commands) + "\n");
    const versions = await p.harness.commit(tx => personalConfigurationVersions(tx, "commands"), context);
    assert.equal(versions[0].content, null); assert.equal(versions[1].origin, "host"); assert.equal(versions[1].content, null); assert.equal(versions[1].revision, "missing");
  } finally { await p.close(); }
});
