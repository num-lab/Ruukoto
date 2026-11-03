import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalFileIo, type PersonalFileIo } from "../apps/ruukoto/src/personal-file-io.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { acquirePersonalDirectory } from "../apps/ruukoto/src/personal-directory-claims.ts";
import { preparePersonalFile } from "../apps/ruukoto/src/personal-tool-io.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { personalWorkResult } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < end, "等待文件工作线程结果超时"); await delay(5); } }

test("文件工作线程：读写请求往返返回结果，跨 64KiB 块的内容变化在复核时拒绝", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data.bin");
  const bytes = Buffer.concat([Buffer.alloc(64 * 1024, 1), Buffer.from("尾块内容")]);
  fs.writeFileSync(target, bytes);
  const io = openPersonalFileIo(); t.after(() => io.close());
  const prepared = await io.prepare({ path: target, access: "read", protectedRoots: [] });
  assert.equal(prepared.originalSha256, createHash("sha256").update(bytes).digest("hex"));
  const read = await io.execute(prepared);
  assert.equal(read.code, "file_returned"); assert.deepEqual(read.bytes, bytes); assert.equal(read.partial, false);
  // 尾部块内的字节变化：逐块哈希在第二块上发现差异，执行拒绝且未写入。
  bytes[64 * 1024 + 3] ^= 0xff; fs.writeFileSync(target, bytes);
  const changed = await io.execute(prepared);
  assert.equal(changed.effect, "not_executed"); assert.equal(changed.code, "file_target_changed");
  const written = await io.execute(await io.prepare({ path: target, access: "read_write", content: "覆盖", protectedRoots: [] }));
  assert.equal(written.code, "file_returned"); assert.equal(fs.readFileSync(target, "utf8"), "覆盖");
});

test("文件工作线程：停顿期间主事件循环与无关短提交继续，工作线程丢失不重派写", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-stall-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data"); fs.writeFileSync(target, "原文");
  const io = openPersonalFileIo({ stallMs: 300 }); t.after(() => io.close());
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 60); t.after(() => clearTimeout(timer));
  const prepared = await io.prepare({ path: target, access: "read", protectedRoots: [] });
  assert.equal(ticked, true);
  // 已退出工作线程：派发立即拒绝，不会悬挂等一个不可能的回复。
  await io.close();
  await assert.rejects(io.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_worker_lost"));
  await assert.rejects(io.execute(prepared), code("file_io_worker_lost"));
});

test("文件工作线程：任务中退出记为丢失，缺失入口拒绝启动", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-crash-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crashing = path.join(root, "crash.mjs");
  fs.writeFileSync(crashing, `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => process.exit(23));\n`);
  const target = path.join(root, "data"); fs.writeFileSync(target, "x");
  const io = openPersonalFileIo({ script: crashing });
  await assert.rejects(io.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_worker_lost"));
  await io.close();
  assert.throws(() => openPersonalFileIo({ script: path.join(root, "missing.mjs") }), code("file_io_worker_unavailable"));
});

test("文件工作线程：宿主写入执行中工作线程丢失保留未知效果与目录占用", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const server = new MockModelServer(request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content.startsWith("tool:")) {
      const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> };
      return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] };
    }
    return { kind: "text", text: `普通:${content}` };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const operations = async () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
  const mode = async (value: "auto-review" | "confirm" | "full_access") => p!.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = value; doc.version++; }, context);

  // 停顿工作线程执行宿主文件请求：无关 Session 提交与宿主查询在停顿中照常完成，证明慢速准备/执行不占事务。
  // 文件工具只保留在子 Agent：读调用经委派工作驱动。
  const stalled = openPersonalFileIo({ stallMs: 400 });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo: stalled });
  await mode("full_access");
  const target = path.join(workspace, "held"); fs.writeFileSync(target, "旧内容");
  await p.answer("读取停顿", "stall-read");
  const readWork = await p.work.delegate({ requestId: "stall-read-work", sourceRequestId: "stall-read", content: `tool:{"name":"read_file","args":{"path":${JSON.stringify(target)}}}` });
  await until(() => operations().then(values => values.length > 0));
  let unrelated = false;
  const commit = p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).version++; }, context).then(() => { unrelated = true; });
  assert.ok(Array.isArray(await p.work.list()));
  await until(() => unrelated);
  const observation = (await operations()).at(-1)!;
  assert.equal(observation.kind, "read_file"); assert.equal(observation.observation, undefined);
  await commit;
  await p.harness.waitForTask(readWork.taskId, context);
  assert.match(await p.harness.commit(tx => personalWorkResult(tx, readWork), context).then(value => value.text ?? ""), /file_returned/);
  assert.equal((await operations()).at(-1)!.effect, "returned");
  await p.close(); p = undefined;

  // 执行时丢失：已认领并已派发写入保持 effect_unknown 与目录占用，不能按丢失回复推断停止或重放。
  const lost: PersonalFileIo = {
    prepare: input => Promise.resolve(preparePersonalFile(input)),
    execute: () => Promise.reject(new PersonalError("file_io_worker_lost", "文件工作线程在任务应答前已结束，原执行结果未能核实；请保留档案并查询原操作。")),
    close: () => Promise.resolve(),
  };
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo: lost });
  await p.answer("写入丢失", "lost-write");
  // 丢失写入记为 effect_unknown 并暂停原源：子工作本身停在未决状态，等待以操作记录为准。
  await p.work.delegate({ requestId: "lost-write-work", sourceRequestId: "lost-write", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(target)},"content":"派发后丢答"}}` });
  await until(async () => { const values = await operations(); return values.some(value => value.kind === "write_file" && value.effect === "effect_unknown"); });
  const record = (await operations()).at(-1)!;
  assert.equal(record.kind, "write_file"); assert.equal(record.started, true);
  assert.equal(record.effect, "effect_unknown"); assert.equal(record.code, "file_io_worker_lost");
  assert.equal(record.stopped, true); assert.ok(record.directoryClaim); assert.equal(record.resolution, undefined);
  // 未知效果未核实前目录占用保留：同一占用键的再次认领必须仍被原操作持有。
  assert.equal(fs.readFileSync(target, "utf8"), "旧内容");
  const stat = fs.statSync(target), retry = (record.operation + 4096) as PersonalToolOperation["operation"];
  await assert.rejects(p.harness.commit(tx => acquirePersonalDirectory(tx, { kind: "file", operation: retry }, { path: target, dev: stat.dev, ino: stat.ino }), context), code("directory_claim_busy"));
});
