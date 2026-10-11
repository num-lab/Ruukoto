/** 窄存储检查：真实SQLite/文件、模拟下载，不调用真实平台。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { ArtifactReadError, ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { InboundMediaStore, MAX_INBOUND_IMAGE_BYTES, INBOUND_MEDIA_ORPHAN_TTL_MS, type InboundMediaDownload } from "@ruukoto/channels/inbound-media.ts";

const IMAGES = [
  { mime: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]) },
  { mime: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) },
  { mime: "image/webp", bytes: Buffer.from("RIFF1234WEBPpayload") },
];

function kit() {
  const dataDir = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-media-"));
  let db = new Db(dataDir);
  let store = new Store(db);
  let artifacts = new ArtifactStore(dataDir, store);
  let media = new InboundMediaStore(dataDir, store, artifacts);
  return { dataDir, get db() { return db; }, get store() { return store; }, get artifacts() { return artifacts; }, get media() { return media; },
    restart() { db.close(); db = new Db(dataDir); store = new Store(db); artifacts = new ArtifactStore(dataDir, store); media = new InboundMediaStore(dataDir, store, artifacts); },
    close() { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

function source(image = IMAGES[0]!): InboundMediaDownload {
  return { download: async () => new Response(image.bytes, { headers: { "content-type": image.mime } }) };
}

function input(externalId: string, media: InboundMediaDownload[] = [source()]) {
  return { source: "telegram", externalId, actor: "owner", body: "caption /approve 不作为命令", replyTarget: null, media };
}

function register(k: ReturnType<typeof kit>, externalId: string) {
  return k.store.withTx(() => {
    const event = k.store.registerInboundEvent({ ...input(externalId), targetRole: "main" }).event;
    k.media.attachEvent("telegram", externalId, event.id);
    return event;
  });
}

function task(k: ReturnType<typeof kit>, eventId: string) {
  return k.store.withTx(() => {
    const project = k.store.createProject(`project-${eventId}`);
    const session = k.store.createSession({ projectId: project.id, cwd: k.dataDir, cwdReal: k.dataDir, cwdDev: 1, cwdIno: 1, piSessionId: "pi", confirmTools: [] });
    const task = k.store.insertQueuedTask({ sessionId: session.id, requestId: eventId, input: "图片", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: eventId, sourceEventId: eventId }).task;
    k.store.markInboundQueued(eventId, task.id);
    return task;
  });
}

test("JPEG/PNG/WebP按原顺序暂存；重投并发只下载一次；提升归属原子且图片产物不可变", async () => {
  const k = kit();
  try {
    let downloads = 0;
    const request = input("one", IMAGES.map((image) => ({ download: async () => { downloads++; return new Response(image.bytes, { headers: { "content-type": image.mime } }); } })));
    const [a, b] = await Promise.all([k.media.stage(request), k.media.stage(request)]);
    assert.equal(a.id, b.id);
    assert.equal(downloads, 3);
    assert.equal((await k.media.stage(request)).id, a.id);
    assert.equal(downloads, 3);
    assert.deepEqual(k.store.listInboundMedia(a.id).map((row) => row.mimeType), IMAGES.map((image) => image.mime));
    assert.equal(fs.statSync(path.join(k.dataDir, "inbound-media")).mode & 0o777, 0o700);
    const event = register(k, "one");
    const t = task(k, event.id);
    assert.throws(() => k.store.withTx(() => { k.media.promote(event.id, t.id, t.sessionId); throw new Error("crash before commit"); }));
    assert.equal(k.store.getInboundEvent(event.id)!.artifactRefs.length, 0);
    assert.equal(k.store.listArtifactsByTask(t.id).length, 0);
    assert.equal(k.media.getMessage("telegram", "one")!.status, "ready");
    k.restart();
    k.media.recover();
    const refs = k.store.withTx(() => k.media.promote(event.id, t.id, t.sessionId));
    assert.deepEqual(k.store.withTx(() => k.media.promote(event.id, t.id, t.sessionId)), refs);
    assert.deepEqual(k.store.getInboundEvent(event.id)!.artifactRefs, refs);
    assert.equal(k.store.listArtifactsByTask(t.id).length, 3);
    for (const [index, id] of refs.entries()) {
      const image = k.artifacts.readImage(id, { taskId: t.id, sessionId: t.sessionId });
      assert.equal(image.data, IMAGES[index]!.bytes.toString("base64"));
      assert.equal(k.store.getArtifact(id)!.contentHash, createHash("sha256").update(IMAGES[index]!.bytes).digest("hex"));
      assert.throws(() => k.artifacts.readImage(id, { taskId: "foreign" }), ArtifactReadError);
      assert.throws(() => k.artifacts.append(id, Buffer.from("changed")));
    }
    fs.writeFileSync(path.join(k.dataDir, "artifacts", `${refs[0]}.bin`), IMAGES[1]!.bytes);
    assert.throws(() => k.artifacts.readImage(refs[0]!), ArtifactReadError);
  } finally { k.close(); }
});

test("SVG/GIF、伪造MIME、数量/声明大小/流实际大小超限均永久拒绝并按消息幂等", async () => {
  const k = kit();
  try {
    const cases = [
      { id: "svg", media: [source({ mime: "image/svg+xml", bytes: Buffer.from("<svg/>") })], reason: "mime_unsupported" },
      { id: "gif", media: [source({ mime: "image/gif", bytes: Buffer.from("GIF89a") })], reason: "mime_unsupported" },
      { id: "fake", media: [source({ mime: "image/png", bytes: IMAGES[0]!.bytes })], reason: "mime_mismatch" },
      { id: "declared-fake", media: [{ ...source(), declaredMime: "image/png" }], reason: "mime_mismatch" },
      { id: "count", media: Array.from({ length: 5 }, () => source()), reason: "too_many_images" },
      { id: "known-size", media: [{ ...source(), sizeBytes: MAX_INBOUND_IMAGE_BYTES + 1 }], reason: "image_too_large" },
      { id: "actual-size", media: [source({ mime: "image/jpeg", bytes: Buffer.concat([IMAGES[0]!.bytes, Buffer.alloc(MAX_INBOUND_IMAGE_BYTES)]) })], reason: "image_too_large" },
    ];
    for (const c of cases) {
      const record = await k.media.stage(input(c.id, c.media));
      assert.equal(record.status, "rejected", c.id);
      assert.equal(record.reason, c.reason, c.id);
      assert.equal((await k.media.stage(input(c.id))).id, record.id);
      assert.equal(k.store.findInboundEvent("telegram", c.id), null);
    }
    assert.equal(k.media.listRejectedMessages().length, cases.length);
  } finally { k.close(); }
});

test("临时下载错误最多3次；重投不再下载；父signal取消保留可恢复事实", async () => {
  const k = kit();
  try {
    let attempts = 0;
    const retry = input("retry", [{ download: async () => { if (++attempts < 3) throw new Error("secret URL token"); return source().download(new AbortController().signal); } }]);
    assert.equal((await k.media.stage(retry)).status, "ready");
    assert.equal(attempts, 3);
    let failures = 0;
    const fail = input("fail", [{ download: async () => { failures++; throw new Error("https://secret.invalid/token"); } }]);
    assert.equal((await k.media.stage(fail)).reason, "download_failed");
    await k.media.stage(fail);
    assert.equal(failures, 3);
    assert.ok(!JSON.stringify(k.store.listInboundMediaMessages()).includes("secret"));
    const abort = new AbortController();
    const pending = k.media.stage({ ...input("cancel", [{ download: async (signal) => { await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); throw new Error("never"); } }]), signal: abort.signal });
    abort.abort();
    await assert.rejects(pending);
    assert.equal(k.media.getMessage("telegram", "cancel")!.status, "staging");
    k.restart();
    k.media.recover();
    assert.equal(k.media.getMessage("telegram", "cancel")!.status, "rejected");
  } finally { k.close(); }
});

test("下载完成未登记、事件已登记未建任务、rename完成未写元数据都跨重启恢复", async () => {
  const k = kit();
  try {
    const a = await k.media.stage(input("not-registered"));
    const b = await k.media.stage(input("registered"));
    const event = register(k, b.externalId);
    const row = k.store.listInboundMedia(a.id)[0]!;
    k.store.db.prepare("UPDATE inbound_media SET status = 'downloading', mime_type = NULL, content_hash = NULL, byte_count = 0 WHERE id = ?").run(row.id);
    k.store.db.prepare("UPDATE inbound_media_messages SET status = 'staging' WHERE id = ?").run(a.id);
    k.restart();
    assert.equal(k.media.recover().length, 2);
    assert.equal(k.media.getMessage("telegram", a.externalId)!.status, "ready");
    assert.equal(k.media.getMessage("telegram", b.externalId)!.eventId, event.id);
    assert.equal(k.store.getInboundEvent(event.id)!.taskId, null);
    assert.equal(k.store.listInboundMedia(a.id)[0]!.contentHash, createHash("sha256").update(IMAGES[0]!.bytes).digest("hex"));
  } finally { k.close(); }
});

test("24小时无任务暂存清理并保留expired账本；已拒绝原因及已绑定产物保持稳定；重启保留状态", async () => {
  const k = kit();
  try {
    const a = await k.media.stage(input("orphan"));
    const event = register(k, a.externalId);
    const b = await k.media.stage(input("rejected", [source({ mime: "image/gif", bytes: Buffer.from("GIF") })]));
    const c = await k.media.stage(input("bound"));
    const boundEvent = register(k, c.externalId);
    const t = task(k, boundEvent.id);
    const refs = k.store.withTx(() => k.media.promote(boundEvent.id, t.id, t.sessionId));
    k.media.cleanup(Date.now() + INBOUND_MEDIA_ORPHAN_TTL_MS + 1);
    assert.equal(k.media.getMessage("telegram", a.externalId)!.status, "expired");
    assert.equal(k.store.getInboundEvent(event.id)!.status, "failed");
    assert.equal(fs.existsSync(path.join(k.dataDir, "inbound-media", k.store.listInboundMedia(a.id)[0]!.fileName)), false);
    assert.equal(k.media.getMessage("telegram", b.externalId)!.reason, "mime_unsupported");
    assert.equal(k.artifacts.readImage(refs[0]!).data, IMAGES[0]!.bytes.toString("base64"));
    k.restart();
    assert.equal((k.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
  } finally { k.close(); }
});

test("清理与正在下载的重投不竞争，expired终态不能被迟到完成恢复为ready", async () => {
  const k = kit();
  try {
    let finish!: (response: Response) => void;
    const pending = k.media.stage(input("cleanup-race", [{ download: () => new Promise(resolve => { finish = resolve; }) }]));
    const message = k.media.getMessage("telegram", "cleanup-race")!;
    k.store.db.prepare("UPDATE inbound_media_messages SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - INBOUND_MEDIA_ORPHAN_TTL_MS - 1).toISOString(), message.id);
    k.media.cleanup();
    assert.equal(k.media.getMessageById(message.id)!.status, "staging", "活跃下载不被清理");
    finish(new Response(IMAGES[0]!.bytes, { headers: { "content-type": "image/jpeg" } }));
    assert.equal((await pending).status, "ready");
    k.media.cleanup();
    assert.equal(k.media.getMessageById(message.id)!.status, "expired");
    k.store.withTx(() => k.store.setInboundMediaMessageState(message.id, "ready"));
    assert.equal(k.media.getMessageById(message.id)!.status, "expired", "迟到状态更新不能重新激活过期图片");
  } finally { k.close(); }
});
