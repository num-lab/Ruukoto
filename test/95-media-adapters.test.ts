/** 工单 25：真实 Runtime + 模拟模型、Bot API 与 OneBot；不连接真实消息平台。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { OneBotClient, OneBotError } from "../src/qq/onebot.ts";
import type { NotifyTarget } from "../src/core/types.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer, type RecordedRequest } from "./helpers/mock-provider.ts";

const TG_TOKEN = "123456:MEDIA-TOKEN-SECRET";
const QQ_TOKEN = "onebot-media-secret";
const TG_OWNER = "42", QQ_ACCOUNT = "990001", QQ_OWNER = "880001";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const pause = (ms = 100) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mainTasks = (rt: Runtime) => rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId);
const inbound = (rt: Runtime, source: string, id: number) => rt.inboundMedia.getMessage(source,
  source === "telegram" ? `123456:${TG_OWNER}:${id}` : `${QQ_ACCOUNT}:${QQ_OWNER}:${id}`);
const latestImages = (request: RecordedRequest) => {
  const content = request.messages.filter((message) => message.role === "user").at(-1)?.content;
  return Array.isArray(content) ? content.filter((block: any) => block.type === "image_url").map((block: any) => block.image_url.url) : [];
};

test("QQ 含图片的长文字保留接收原文，并按既有正文预算生成有图请求", async () => {
  const h = await harness("media-long-caption");
  try {
    const caption = "MARK-LONG-CAPTION " + "字".repeat(9000) + " ORIGINAL-CAPTION-END";
    h.pushQq(901, [{ type: "text", data: { text: caption } }, h.image("png")]);
    await waitFor("长文字图片回复", () => h.qqSends.length === 1);
    assert.equal(mainTasks(h.rt).length, 1);
    assert.ok(inbound(h.rt, "qq_private", 901)!.body.endsWith("ORIGINAL-CAPTION-END"));
    assert.deepEqual(latestImages(h.model.calls[0]!), [`data:image/png;base64,${PNG.toString("base64")}`]);
  } finally { await h.close(); }
});

async function harness(prefix: string, imageInput = true) {
  const { dirs } = await makeTestDirs(prefix, 0);
  const model = new MockModelServer((request) => ({ kind: "text", text: `REPLY ${lastUserText(request).match(/MARK-[A-Z0-9-]+/g)?.at(-1) ?? "image"}` }));
  await writeModelsJson(dirs, await model.start());
  const modelsPath = path.join(dirs.agentDir, "models.json");
  const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  models.providers.mock.models[0].input = imageInput ? ["text", "image"] : ["text"];
  fs.writeFileSync(modelsPath, JSON.stringify(models));
  const files = new Map<string, { bytes: Buffer; mime: string; failures?: number; hold?: Promise<void>; contentLength?: number }>([
    ["png", { bytes: PNG, mime: "image/png" }], ["jpeg", { bytes: JPEG, mime: "image/jpeg" }], ["webp", { bytes: WEBP, mime: "image/webp" }],
  ]);
  const downloads: string[] = [], getFiles: string[] = [], tgSends: any[] = [], qqSends: any[] = [];
  const getImages = new Map<string, { url?: string; file?: string }>();
  const updates: any[] = [];
  let base = "", updateId = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      const raw: Buffer[] = [];
      for await (const chunk of request) raw.push(Buffer.from(chunk));
      const body = raw.length ? JSON.parse(Buffer.concat(raw).toString()) : {};
      const json = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === `/bot${TG_TOKEN}/getUpdates`) {
        await pause(25);
        json({ ok: true, result: updates.filter((update) => update.update_id >= body.offset) });
      } else if (request.url === `/bot${TG_TOKEN}/getFile`) {
        getFiles.push(body.file_id);
        json({ ok: true, result: { file_path: body.file_id } });
      } else if (request.url === `/bot${TG_TOKEN}/sendMessage`) {
        tgSends.push(body);
        json({ ok: true, result: { message_id: 1000 + tgSends.length } });
      } else {
        const id = request.url?.startsWith(`/file/bot${TG_TOKEN}/`) ? request.url.slice(`/file/bot${TG_TOKEN}/`.length) : request.url?.slice("/image/".length);
        const file = id ? files.get(id) : undefined;
        if (!file) { response.writeHead(404); response.end(); return; }
        downloads.push(id!);
        await file.hold;
        if ((file.failures ?? 0) > 0) { file.failures!--; response.writeHead(503); response.end(`server error ${TG_TOKEN}`); return; }
        response.writeHead(200, { "content-type": file.mime, "content-length": file.contentLength ?? file.bytes.length });
        response.end(file.bytes);
      }
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    if (request.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.close(4401); return; }
    socket.on("message", (raw) => {
      const { action, params, echo } = JSON.parse(String(raw));
      const reply = (data: unknown) => socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo }));
      if (action === "get_login_info") reply({ user_id: Number(QQ_ACCOUNT) });
      else if (action === "get_status") reply({ online: true, good: true });
      else if (action === "get_image" && params.file === "silent-image") return;
      else if (action === "get_image" && getImages.has(params.file)) reply(getImages.get(params.file));
      else if (action === "send_private_msg") { qqSends.push(params); reply({ message_id: 2000 + qqSends.length }); }
      else socket.send(JSON.stringify({ status: "failed", retcode: 1404, msg: `${QQ_TOKEN} ${base}/private-error`, echo }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: createMockTools,
    telegram: { pollTimeoutSec: 1, backoffMs: 25 },
    qq: { actionTimeoutMs: 300, probeIntervalMs: 100, reconnectMinMs: 30, reconnectMaxMs: 100, sweepIntervalMs: 70 },
    scheduler: { tickMs: 25, sendTimeoutMs: 1000 },
  };
  let runtime = await Runtime.start(config);
  const waitOnline = () => waitFor("模拟 Telegram 与 QQ 已在线", () => runtime.telegramStatus().online === true && runtime.qqStatus().online === true);
  await runtime.addCredentialBinding({ name: "media-tg", host: new URL(base).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
  await runtime.telegramConfigure({ apiBase: base, credential: "media-tg", ownerUserId: TG_OWNER });
  await runtime.telegramSetEnabled(true);
  await runtime.addCredentialBinding({ name: "media-qq", host: new URL(base).host, header: "authorization", purpose: "qq_onebot", secret: QQ_TOKEN });
  await runtime.qqConfigure({ endpoint: base.replace("http:", "ws:"), credential: "media-qq", selfId: QQ_ACCOUNT, ownerUserId: QQ_OWNER });
  await runtime.qqSetEnabled(true);
  await waitOnline();
  const pushTg = (id: number, caption?: string, extra: Record<string, unknown> = {}) => {
    const message = { message_id: id, date: 1_790_000_000, chat: { id: Number(TG_OWNER), type: "private" }, from: { id: Number(TG_OWNER) },
      photo: [{ file_id: "png", width: 1000, height: 1000 }], ...(caption === undefined ? {} : { caption }), ...extra };
    updates.push({ update_id: ++updateId, message });
    return updateId;
  };
  const pushQq = (id: number, segments: unknown[], extra: Record<string, unknown> = {}) => {
    const event = { post_type: "message", message_type: "private", sub_type: "friend", self_id: Number(QQ_ACCOUNT), user_id: Number(QQ_OWNER),
      message_id: id, message: segments, sender: { user_id: Number(QQ_OWNER) }, time: 1_790_000_000, ...extra };
    for (const socket of wss.clients) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const image = (id: string, extra = {}) => ({ type: "image", data: { url: `${base}/image/${id}`, ...extra } });
  return {
    get rt() { return runtime; }, dirs, config, model, files, downloads, getFiles, getImages, tgSends, qqSends, pushTg, pushQq, image,
    async restart() { await runtime.stop("test_restart"); runtime = await Runtime.start(config); await waitOnline(); },
    async close() {
      await runtime.stop("test_end");
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await model.close(); await cleanupDirs(dirs);
    },
  };
}

test("Telegram 与 QQ 图片进入真实模型 payload：caption、无文字、回复、最大尺寸、四张顺序及重启重投", async () => {
  const h = await harness("media-adapters-payload");
  try {
    h.pushTg(1, undefined, { photo: [
      { file_id: "small", width: 10, height: 10, file_size: 900 },
      { file_id: "png", width: 1000, height: 1000, file_size: PNG.length },
      { file_id: "middle", width: 20, height: 20, file_size: 1000 },
    ], reply_to_message: { message_id: 99, from: { is_bot: true }, caption: "引用图片说明" } });
    h.pushTg(2, "/approve arbitrary MARK-TG-CAPTION");
    h.pushQq(1, [h.image("jpeg")]);
    const qqSegments = [{ type: "reply", data: { id: "99" } }, { type: "text", data: { text: "/approve arbitrary MARK-QQ-CAPTION" } },
      h.image("png"), h.image("webp"), h.image("jpeg"), h.image("png")];
    h.pushQq(2, qqSegments);
    await waitFor("两平台四条媒体任务和回复完成", () => mainTasks(h.rt).length === 4 && mainTasks(h.rt).every((task) => task.status === "completed") && h.tgSends.length === 2 && h.qqSends.length === 2);
    assert.equal(h.model.calls.length, 4);
    const tgCall = h.model.calls.find((request) => lastUserText(request).includes("MARK-TG-CAPTION"))!;
    const qqCall = h.model.calls.find((request) => lastUserText(request).includes("MARK-QQ-CAPTION"))!;
    assert.deepEqual(latestImages(tgCall), [`data:image/png;base64,${PNG.toString("base64")}`]);
    assert.deepEqual(latestImages(qqCall), [PNG, WEBP, JPEG, PNG].map((bytes, index) => `data:${["image/png", "image/webp", "image/jpeg", "image/png"][index]};base64,${bytes.toString("base64")}`));
    assert.ok(mainTasks(h.rt).some((task) => task.input.includes("引用图片说明")));
    assert.ok(mainTasks(h.rt).some((task) => task.input.includes("回复关联：message 99（未读取引用原文）")));
    assert.deepEqual(h.getFiles, ["png", "png"]);
    for (const source of ["telegram", "qq_private"]) for (const id of [1, 2]) {
      const message = inbound(h.rt, source, id)!;
      assert.equal(message.status, "bound");
      const event = h.rt.store.getInboundEvent(message.eventId!)!;
      assert.equal(event.eventKind, "task", "含图审批文字只作任务正文");
      assert.equal(event.artifactRefs.length, message.mediaCount);
      assert.ok(event.artifactRefs.every((ref) => h.rt.store.getArtifact(ref)?.status === "complete"));
    }
    const main = h.rt.store.getSession(h.rt.store.getAgentRole("main")!.sessionId)!;
    const history = fs.readFileSync(main.sessionFile!, "utf8");
    for (const bytes of [PNG, WEBP, JPEG]) assert.ok(!history.includes(bytes.toString("base64")), "会话 JSONL 保存引用，不重复保存图片 base64");
    const downloadCount = h.downloads.length;
    await h.restart();
    h.pushTg(2, "/approve arbitrary MARK-TG-CAPTION");
    h.pushQq(2, qqSegments);
    await waitFor("Telegram 重投偏移已经推进", () => h.rt.telegramStore.getConfig()!.lastUpdateId === 3);
    await pause();
    assert.equal(mainTasks(h.rt).length, 4);
    assert.equal(h.downloads.length, downloadCount, "bound 重投不下载");
    assert.equal(h.model.calls.length, 4);
    assert.equal(h.tgSends.length + h.qqSends.length, 4);
    for (const value of [h.model.calls, h.rt.inboundMedia.getMessage("telegram", "123456:42:1"), h.rt.sched.listOps({ limit: 50 }), h.rt.store.db.prepare("SELECT body FROM events").all()]) {
      assert.ok(!JSON.stringify(value).includes(TG_TOKEN)); assert.ok(!JSON.stringify(value).includes(QQ_TOKEN));
    }
  } finally { await h.close(); }
});

test("Telegram 下载在决定前保留 offset，临时错误有界重试；QQ url/file 和重试保持图片顺序", async () => {
  const h = await harness("media-adapters-retry");
  let release!: () => void;
  try {
    h.files.set("retry-tg", { bytes: PNG, mime: "image/png", failures: 1, hold: new Promise<void>((resolve) => { release = resolve; }) });
    h.pushTg(1, "MARK-TG-RETRY", { photo: [{ file_id: "retry-tg", width: 1, height: 1 }] });
    await waitFor("下载开始", () => h.downloads.includes("retry-tg"));
    assert.equal(h.rt.telegramStore.getConfig()!.lastUpdateId, 0);
    assert.equal(mainTasks(h.rt).length, 0);
    release();
    h.files.set("retry-qq", { bytes: WEBP, mime: "image/webp", failures: 1 });
    h.getImages.set("opaque-image-id", { url: h.image("jpeg").data.url });
    h.pushQq(1, [{ type: "text", data: { text: "MARK-QQ-RETRY" } }, h.image("retry-qq"), { type: "image", data: { file: "opaque-image-id" } },
      { type: "image", data: { file: h.image("png").data.url } }]);
    await waitFor("两平台重试成功", () => h.tgSends.length === 1 && h.qqSends.length === 1);
    assert.equal(h.downloads.filter((id) => id === "retry-tg").length, 2);
    assert.equal(h.downloads.filter((id) => id === "retry-qq").length, 2);
    assert.equal(h.rt.telegramStore.getConfig()!.lastUpdateId, 1);
    const qqCall = h.model.calls.find((request) => lastUserText(request).includes("MARK-QQ-RETRY"))!;
    assert.deepEqual(latestImages(qqCall), [WEBP, JPEG, PNG].map((bytes, index) => `data:${["image/webp", "image/jpeg", "image/png"][index]};base64,${bytes.toString("base64")}`));
    const client = new OneBotClient({ endpoint: new URL(h.image("png").data.url).origin.replace("http:", "ws:"), token: QQ_TOKEN, onEvent: () => {} });
    client.start();
    try {
      await waitFor("OneBot 文件查询连接已在线", () => client.online);
      const aborter = new AbortController();
      const pending = client.call("get_image", { file: "silent-image" }, aborter.signal);
      aborter.abort();
      await assert.rejects(pending, (error) => error instanceof OneBotError && !error.definite && error.message === "OneBot 动作已取消");
      assert.deepEqual(await client.call("get_status", {}), { online: true, good: true }, "中止文件查询不关闭连接");
    } finally { await client.stop(); }
  } finally { release?.(); await h.close(); }
});

test("Telegram 二进制下载按 getFile 的扩展声明 MIME，实际内容不符时拒绝", async () => {
  const h = await harness("media-adapters-octet");
  try {
    h.files.set("photo.jpg", { bytes: JPEG, mime: "application/octet-stream" });
    h.files.set("forged.jpg", { bytes: PNG, mime: "application/octet-stream" });
    h.pushTg(1, "MARK-TG-OCTET", { photo: [{ file_id: "photo.jpg", width: 1, height: 1 }] });
    h.pushTg(2, "MARK-TG-FORGED", { photo: [{ file_id: "forged.jpg", width: 1, height: 1 }] });
    await waitFor("二进制 JPEG 执行、伪造扩展拒绝", () => h.tgSends.length === 2);
    assert.equal(mainTasks(h.rt).length, 1);
    assert.equal(h.model.calls.length, 1);
    assert.deepEqual(latestImages(h.model.calls[0]!), [`data:image/jpeg;base64,${JPEG.toString("base64")}`]);
    assert.equal(inbound(h.rt, "telegram", 1)!.status, "bound");
    assert.equal(inbound(h.rt, "telegram", 2)!.status, "rejected");
    assert.equal(inbound(h.rt, "telegram", 2)!.reason, "mime_mismatch");
  } finally { await h.close(); }
});

test("媒体永久拒绝不建任务：不允许 MIME、magic 不符、过大、超数量、不可访问 OneBot 文件和重试耗尽，固定回执幂等", async () => {
  const h = await harness("media-adapters-rejected");
  try {
    h.files.set("gif", { bytes: Buffer.from("GIF89a"), mime: "image/gif" });
    h.files.set("svg", { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), mime: "image/svg+xml" });
    h.files.set("forged", { bytes: PNG, mime: "image/jpeg" });
    h.files.set("magic", { bytes: Buffer.from("not an image"), mime: "image/png" });
    h.files.set("oversize", { bytes: PNG, mime: "image/png", contentLength: 8 * 1024 * 1024 + 1 });
    h.files.set("never", { bytes: PNG, mime: "image/png", failures: 20 });
    for (const [index, id] of ["gif", "svg", "forged", "magic", "oversize", "never"].entries()) {
      h.pushTg(index + 1, undefined, { photo: [{ file_id: id, width: 1, height: 1 }] });
      h.pushQq(index + 1, [h.image(id)]);
    }
    h.pushQq(7, Array.from({ length: 5 }, () => h.image("png")));
    h.pushQq(8, [{ type: "image", data: { file: "unknown-file" } }]);
    h.getImages.set("remote-local", { file: "/private/onebot/photo.png" });
    h.pushQq(9, [{ type: "image", data: { file: "remote-local" } }]);
    h.pushQq(10, [h.image("png", { mime_type: "image/jpeg" })]);
    // 身份不匹配不下载、不登记拒绝、更不发送宿主回执。
    h.pushQq(90, [h.image("png")], { sub_type: "group" });
    h.pushQq(91, [h.image("png")], { user_id: 880002, sender: { user_id: 880002 } });
    h.pushTg(90, undefined, { from: { id: 99 } });
    await waitFor("全部拒绝回执发送一次", () => h.tgSends.length === 6 && h.qqSends.length === 10, 20_000);
    assert.equal(mainTasks(h.rt).length, 0);
    assert.equal(h.model.calls.length, 0);
    assert.equal(h.rt.telegramStore.getConfig()!.lastUpdateId, 7);
    assert.equal(h.downloads.filter((id) => id === "never").length, 6, "每平台各重试三次");
    assert.equal(h.downloads.filter((id) => id === "png").length, 1, "只有声明 MIME 不符的图片需要下载核实；超数量与身份拒绝不下载");
    for (const source of ["telegram", "qq_private"]) {
      for (let id = 1; id <= (source === "telegram" ? 6 : 10); id++) {
        const message = inbound(h.rt, source, id)!;
        assert.equal(message.status, "rejected");
        assert.equal(message.eventId, null, "拒绝账本不冒充普通入站任务");
      }
    }
    assert.equal(inbound(h.rt, "qq_private", 8)!.reason, "download_unavailable");
    assert.equal(inbound(h.rt, "qq_private", 9)!.reason, "download_unavailable");
    const receipts = [...h.tgSends.map((send) => send.text), ...h.qqSends.map((send) => send.message.find((segment: any) => segment.type === "text").data.text)];
    assert.ok(h.tgSends.every((send) => String(send.chat_id) === TG_OWNER));
    assert.ok(h.qqSends.every((send) => String(send.user_id) === QQ_OWNER));
    assert.ok(receipts.every((text) => !text.includes(TG_TOKEN) && !text.includes(QQ_TOKEN) && !text.includes("http")));
    assert.equal(new Set(receipts).size, 2, "普通媒体拒绝与最终下载失败仅用宿主固定正文");
    const downloads = h.downloads.length;
    await h.restart();
    h.pushTg(6, undefined, { photo: [{ file_id: "never", width: 1, height: 1 }] });
    h.pushQq(6, [h.image("never")]); h.pushQq(8, [{ type: "image", data: { file: "unknown-file" } }]);
    await waitFor("拒绝重投推进偏移", () => h.rt.telegramStore.getConfig()!.lastUpdateId === 8);
    await pause();
    assert.equal(h.downloads.length, downloads);
    assert.equal(h.tgSends.length + h.qqSends.length, 16);
  } finally { await h.close(); }
});

test("两平台图片模型能力不足在请求前失败，保留原消息与固定回执，重投不再发送", async () => {
  const h = await harness("media-adapters-no-vision", false);
  try {
    h.pushTg(1, "MARK-TG-UNSUPPORTED");
    const segments = [{ type: "text", data: { text: "MARK-QQ-UNSUPPORTED" } }, h.image("webp")];
    h.pushQq(1, segments);
    await waitFor("能力不足的两平台固定回执已发送", () => h.tgSends.length === 1 && h.qqSends.length === 1);
    assert.equal(h.model.calls.length, 0);
    assert.equal(mainTasks(h.rt).length, 0, "模型能力不足在普通任务创建前拒绝");
    for (const source of ["telegram", "qq_private"]) {
      const message = inbound(h.rt, source, 1)!;
      assert.equal(message.reason, "image_input_unsupported");
      assert.ok(message.body.includes("UNSUPPORTED"));
    }
    assert.equal(h.tgSends[0].text, h.qqSends[0].message.find((segment: any) => segment.type === "text").data.text);
    h.pushTg(1, "MARK-TG-UNSUPPORTED"); h.pushQq(1, segments);
    await waitFor("能力不足重投已消费", () => h.rt.telegramStore.getConfig()!.lastUpdateId === 2);
    await pause();
    assert.equal(h.tgSends.length + h.qqSends.length, 2);
    assert.equal(h.model.calls.length, 0);
  } finally { await h.close(); }
});

test("两平台暂存完成但尚未登记时轮换配置，重投保留原信封并拒绝旧代次", async () => {
  const h = await harness("media-adapters-staged-generation");
  try {
    const targets: Record<string, NotifyTarget> = {
      telegram: { channel: "telegram", account: "123456", chatId: TG_OWNER, configVersion: h.rt.telegramStore.getConfig()!.configVersion },
      qq_private: { channel: "qq_private", account: QQ_ACCOUNT, chatId: QQ_OWNER, configVersion: h.rt.qqStore.getConfig()!.configVersion },
    };
    for (const source of ["telegram", "qq_private"]) {
      const target = targets[source]!;
      const staged = await h.rt.inboundMedia.stage({ source, externalId: `${target.account}:${target.chatId}:15`,
        actor: `${source}:${target.chatId}`, body: `ORIGINAL-${source}`, replyTarget: target,
        media: [{ download: async () => new Response(PNG, { headers: { "content-type": "image/png" } }) }],
      });
      assert.equal(staged.status, "ready"); assert.equal(staged.eventId, null);
    }
    const base = new URL(h.image("png").data.url).origin;
    await h.rt.telegramConfigure({ apiBase: base, credential: "media-tg", ownerUserId: TG_OWNER });
    await h.rt.qqConfigure({ endpoint: base.replace("http:", "ws:"), credential: "media-qq", selfId: QQ_ACCOUNT, ownerUserId: QQ_OWNER });
    await waitFor("新代次两平台在线", () => h.rt.telegramStatus().online === true && h.rt.qqStatus().online === true);
    h.pushTg(15, "REDELIVERED-TG");
    h.pushQq(15, [{ type: "text", data: { text: "REDELIVERED-QQ" } }, h.image("png")]);
    await waitFor("旧暂存重投入站作废", () => ["telegram", "qq_private"].every((source) => {
      const message = inbound(h.rt, source, 15);
      return !!message?.eventId && h.rt.store.getInboundEvent(message.eventId)?.status === "failed";
    }));
    for (const source of ["telegram", "qq_private"]) {
      const message = inbound(h.rt, source, 15)!;
      const event = h.rt.store.getInboundEvent(message.eventId!)!;
      assert.deepEqual(event.replyTarget, targets[source], "事件沿用首次暂存的固定目标与配置代次");
      assert.equal(event.body, `ORIGINAL-${source}`, "新代次重投不能改写旧正文");
      assert.equal(event.taskId, null);
    }
    assert.equal(mainTasks(h.rt).length, 0); assert.equal(h.model.calls.length, 0);
    assert.equal(h.downloads.length, 0, "暂存已完成不重新下载");
    await pause();
    assert.equal(h.tgSends.length + h.qqSends.length, 0, "旧代次媒体不借新入口执行或发送回执");
  } finally { await h.close(); }
});
