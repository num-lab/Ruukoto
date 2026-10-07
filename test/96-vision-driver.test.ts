import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Driver } from "../src/agent/driver.ts";
import { IMAGE_INPUT_UNSUPPORTED, imageReferenceView, taskImageReferences } from "../src/agent/inbound-images.ts";
import { ToolOpLedger } from "../src/agent/tool-op-ledger.ts";
import { estimateMessageTokens } from "../src/agent/context-selector.ts";
import { checkpointFingerprint, COMPACTION_PROMPT_VERSION } from "../src/agent/compaction.ts";
import { HistoryIndex } from "../src/core/history-index.ts";
import { parseSessionFile, readHistoryPage } from "../src/core/history.ts";
import { randomId, type Session, type Task } from "../src/core/types.ts";
import { startAssemblyKit, waitFor } from "./helpers/testkit.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 1, 2, 3, 4]);

async function fixture(prefix: string, vision = true, holdFirst = false) {
  let releaseFirst = () => {};
  let releaseSecond = () => {};
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const kit = await startAssemblyKit(prefix, { responder: async (_req, index) => {
    if (index === 0 && holdFirst) await first;
    if (index === 1 && holdFirst) await second;
    return { kind: "text", text: "看到了图片" };
  } });
  const { session } = kit.project();
  let supportsImages = vision;
  const originalResolve = kit.deps.modelCatalog.resolve.bind(kit.deps.modelCatalog);
  kit.deps.modelCatalog.resolve = async (selection) => ({ ...await originalResolve(selection), input: supportsImages ? ["text", "image"] : ["text"] });
  const driverFor = (current: Session = session) => new Driver(current, {
    ...kit.deps, ledger: new ToolOpLedger(kit.store), historyIndex: new HistoryIndex(kit.store.db),
    sessionsDir: path.join(kit.dirs.dataDir, "sessions"), model: kit.model, thinkingLevel: "off",
    toolFactory: () => [], launcherFor: () => { throw new Error("本测试不运行工具"); },
    protectedRoots: [kit.dirs.dataDir], onOccupancyReleased: () => {}, hostToolFamilies: [],
  });
  const imageTask = () => kit.store.withTx(() => {
    const { event } = kit.store.registerInboundEvent({ source: "telegram", externalId: randomId("incoming"), actor: "telegram:owner", targetRole: "main", body: "这两张图有什么区别？" });
    const task = kit.store.insertQueuedTask({ sessionId: session.id, requestId: randomId("req"), input: event.body,
      modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, submissionDigest: randomId("digest"), sourceEventId: event.id }).task;
    const ids = [PNG, JPEG].map((bytes, index) => kit.deps.artifacts.importImage({ id: randomId("art"), taskId: task.id, sessionId: session.id,
      name: `inbound-image:${index}`, mimeType: index === 0 ? "image/png" : "image/jpeg", byteCount: bytes.length,
      contentHash: createHash("sha256").update(bytes).digest("hex") }, bytes).id);
    kit.store.markInboundQueued(event.id, task.id);
    kit.store.db.prepare("UPDATE inbound_events SET artifact_refs = ? WHERE id = ?").run(JSON.stringify(ids), event.id);
    return task;
  });
  const run = async (driver: Driver, task: Task) => {
    kit.store.withTx(() => kit.store.transitionTask(task.id, ["queued"], "running"));
    await driver.run(kit.store.getTask(task.id)!);
    return kit.store.getTask(task.id)!;
  };
  return { ...kit, session, driverFor, imageTask, run, releaseFirst, releaseSecond, textOnly: () => { supportsImages = false; } };
}

function imageUrls(message: any): string[] {
  return Array.isArray(message?.content) ? message.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) : [];
}

test("首次图片与重开会话的两次 resumesTaskId 续聊保留顺序、稳定引用和图片预算，JSONL/快照不存 base64", async () => {
  const k = await fixture("vision-history", true, true);
  let driver = k.driverFor();
  try {
    const task = k.imageTask();
    const refs = taskImageReferences(task, k.store);
    assert.deepEqual(refs.map((ref) => ref.mimeType), ["image/png", "image/jpeg"]);
    const tokens = estimateMessageTokens(imageReferenceView([{ role: "user", content: task.input, ruukotoMediaRefs: refs }], k.session.id)[0], 1);
    assert.ok(tokens >= 2400, "SDK 对每张图片估算至少 1200 token，图片预算不会按空正文计数");
    const running = k.run(driver, task);
    await waitFor("首次图片请求已发出", () => k.server.calls.length === 1);
    const stopping = driver.requestStop(task, { terminal: "interrupted", reason: "owner_interrupt", cancelIntent: false });
    k.releaseFirst();
    await stopping;
    assert.equal((await running).status, "interrupted");
    const expected = [`data:image/png;base64,${PNG.toString("base64")}`, `data:image/jpeg;base64,${JPEG.toString("base64")}`];
    assert.deepEqual(imageUrls(k.server.calls[0]!.messages.at(-1)), expected);
    await driver.dispose();
    driver = k.driverFor(k.store.getSession(k.session.id)!);
    const resume = k.task(k.session, "继续看图片", task.id);
    const resuming = k.run(driver, resume);
    await waitFor("继续图片请求已发出", () => k.server.calls.length === 2);
    const stopResume = driver.requestStop(resume, { terminal: "interrupted", reason: "owner_interrupt", cancelIntent: false });
    k.releaseSecond();
    await stopResume;
    assert.equal((await resuming).status, "interrupted");
    assert.deepEqual(imageUrls(k.server.calls[1]!.messages.at(-1)), expected, "源图片在本轮用户消息中必留");
    const historyMessages = parseSessionFile(k.store.getSession(k.session.id)!.sessionFile!)
      .filter((entry) => entry.type === "message").map((entry) => entry.message);
    k.store.withTx(() => k.store.insertCheckpoint({
      id: randomId("ckpt"), sessionId: k.session.id, summarizedCount: historyMessages.length, clearedCount: historyMessages.length,
      fingerprint: checkpointFingerprint(historyMessages, historyMessages.length), summary: "较早图片对话已压缩，细节需查看原始图片。", summaryUntil: new Date().toISOString(),
      clearedRefs: {}, clearedResults: 0, summaryModel: "mock/mock-model", summaryStatus: "ok", summaryError: null,
      promptVersion: COMPACTION_PROMPT_VERSION, usage: null, estimateBefore: 10000, estimateAfter: 100, taskId: resume.id, callIndex: 1, createdAt: new Date().toISOString(),
    }));
    const again = k.task(k.session, "继续回答", resume.id);
    assert.equal((await k.run(driver, again)).status, "completed");
    assert.deepEqual(imageUrls(k.server.calls[2]!.messages.at(-1)), expected, "原对话已摘要后继续链仍能找回最初图片");
    assert.equal(k.server.calls[2]!.messages.flatMap(imageUrls).length, 2);

    const file = k.store.getSession(k.session.id)!.sessionFile!;
    const jsonl = fs.readFileSync(file, "utf8");
    assert.ok(!jsonl.includes(PNG.toString("base64")) && !jsonl.includes(JPEG.toString("base64")));
    const user = parseSessionFile(file).filter((entry) => entry.type === "message" && (entry.message as any)?.role === "user");
    assert.equal(user.length, 3);
    for (const entry of user) assert.deepEqual((entry.message as any).ruukotoMediaRefs, refs);
    assert.ok(readHistoryPage(file).entries.filter((entry) => entry.role === "user").every((entry) => entry.hasNonTextContent));
    for (const t of [task, resume, again]) {
      const record = k.store.listSelectionRecordsByTask(t.id)[0]!;
      const snapshot = k.deps.artifacts.read(record.promptArtifactId!, 0, 1024 * 1024).toString("utf8");
      assert.ok(!snapshot.includes(PNG.toString("base64")) && !snapshot.includes(JPEG.toString("base64")));
      assert.match(snapshot, /image_ref/);
      assert.ok(record.estimatedTotal >= 2400);
    }
  } finally { k.releaseFirst(); k.releaseSecond(); await driver.dispose(); await k.close(); }
});

test("图片任务与历史图片进入仅文本模型时在请求前失败并保留明确错误码", async () => {
  const k = await fixture("vision-unsupported", false);
  let driver = k.driverFor();
  try {
    const rejected = k.imageTask();
    assert.equal((await k.run(driver, rejected)).status, "failed");
    assert.match(k.store.getTask(rejected.id)!.errorMessage!, new RegExp(IMAGE_INPUT_UNSUPPORTED));
    assert.equal(k.server.calls.length, 0);
    assert.equal(k.store.getTask(rejected.id)!.input, "这两张图有什么区别？");
  } finally { await driver.dispose(); await k.close(); }

  const history = await fixture("vision-text-history");
  driver = history.driverFor();
  try {
    await history.run(driver, history.imageTask());
    const before = history.server.calls.length;
    history.textOnly();
    await driver.dispose();
    driver = history.driverFor(history.store.getSession(history.session.id)!);
    const plain = history.task(history.session, "接着回答");
    assert.equal((await history.run(driver, plain)).status, "failed");
    assert.match(history.store.getTask(plain.id)!.errorMessage!, new RegExp(IMAGE_INPUT_UNSUPPORTED));
    assert.equal(history.server.calls.length, before, "提供方无法静默丢弃上下文中的历史图片");
    assert.equal(history.store.getSession(history.session.id)!.queueState, "active");
  } finally { await driver.dispose(); await history.close(); }
});

test("入站图片文件被替换后拒绝请求，当前用户历史仍保存稳定引用", async () => {
  const k = await fixture("vision-corrupt");
  const driver = k.driverFor();
  try {
    const task = k.imageTask();
    const [ref] = taskImageReferences(task, k.store);
    fs.writeFileSync(path.join(k.dirs.dataDir, "artifacts", `${ref!.artifactId}.bin`), Buffer.from("invalid"));
    const ended = await k.run(driver, task);
    assert.equal(ended.status, "interrupted");
    assert.match(ended.interruptReason!, /image_reference_invalid/);
    assert.equal(k.server.calls.length, 0);
    const file = k.store.getSession(k.session.id)!.sessionFile!;
    assert.ok(fs.readFileSync(file, "utf8").includes(ref!.artifactId));
  } finally { await driver.dispose(); await k.close(); }
});

test("图片超过必留内容预算时中断，不能删除图片后发送", async () => {
  const k = await fixture("vision-budget");
  k.deps.budgetOverrides = { contextWindow: 14000 };
  const driver = k.driverFor();
  try {
    const task = k.imageTask();
    const ended = await k.run(driver, task);
    assert.equal(ended.status, "interrupted");
    assert.match(ended.interruptReason!, /context_budget_exceeded/);
    assert.equal(k.server.calls.length, 0);
  } finally { await driver.dispose(); await k.close(); }
});
