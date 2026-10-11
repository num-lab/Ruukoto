import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
/** 图片入站三个持久化窗口：模拟平台与模型，真实 Runtime / SQLite / 文件。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { startMockOneBot, MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET } from "./helpers/mock-onebot.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOaQAAAAASUVORK5CYII=", "base64");
const TG_TOKEN = "123456:RECOVERY-SECRET";
const OWNER = "42";

for (const source of ["telegram", "qq_private"] as const) {
  test(`${source} 暂存/登记/建任务窗口重启恢复且重投幂等`, async () => {
    const owner = source === "telegram" ? OWNER : "880001";
    const { dirs } = await makeTestDirs(`media-recover-${source}`, 0);
    const model = new MockModelServer(async () => ({ kind: "text", text: "已看到图片" }));
    await writeModelsJson(dirs, await model.start());
    const file = path.join(dirs.agentDir, "models.json");
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    catalog.providers.mock.models[0].input.push("image");
    fs.writeFileSync(file, JSON.stringify(catalog));
    const bot = new FakeBotApi({ token: TG_TOKEN });
    const apiBase = await bot.start();
    const onebot = await startMockOneBot({});
    const config: RuntimeConfig = {
    product: personalProduct.runtime,
      dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
      modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", toolFactory: createMockTools,
      telegram: { pollTimeoutSec: 1, backoffMs: 30 },
      qq: { actionTimeoutMs: 500, probeIntervalMs: 50, sweepIntervalMs: 50 },
      scheduler: { tickMs: 30, sendTimeoutMs: 1000 },
    };
    let rt = await Runtime.start(config);
    try {
      if (source === "telegram") {
        await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
        await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: OWNER });
        await rt.telegramSetEnabled(true);
        await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
      } else {
        await rt.addCredentialBinding({ name: "qq", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
        await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq", ownerUserId: owner });
        await rt.qqSetEnabled(true);
        await waitFor("QQ 在线", () => rt.qqStatus().online === true);
      }
      const main = rt.store.getAgentRole("main")!;
      const cfg = source === "telegram" ? rt.telegramStore.getConfig()! : rt.qqStore.getConfig()!;
      const account = source === "telegram" ? "123456" : MOCK_QQ_ACCOUNT;
      const target = { channel: source, account, chatId: owner, configVersion: cfg.configVersion };
      let downloads = 0;
      for (let window = 0; window < 3; window++) {
        const externalId = `${account}:${owner}:${800 + window}`;
        const envelope = { source, externalId, actor: `${source}:${owner}`, body: `恢复窗口 ${window}`, replyTarget: target };
        rt.store.db.prepare("UPDATE sessions SET queue_state = 'paused', queue_pause_reason = 'backend_restart' WHERE id = ?").run(main.sessionId);
        await rt.inboundMedia.stage({ ...envelope, media: [{ declaredMime: "image/png", download: async () => {
          downloads++;
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        } }] });
        if (window >= 1) {
          const { event } = rt.store.withTx(() => rt.store.registerInboundEvent({ ...envelope, targetRole: "main" }));
          rt.inboundMedia.attachEvent(source, externalId, event.id);
          if (window === 2) {
            await rt.submit({
            sessionId: main.sessionId, requestId: `evt:${event.id}`,
            input: `[入站事件] 来源：${source} 外部 id：${externalId} actor：${envelope.actor}\n${envelope.body}`,
            accessMode: "confirm", agentId: "main", sourceEventId: event.id, modelSelection: rt.defaultSelection,
            });
            const current = rt.store.getSession(main.sessionId)!;
            await rt.setSessionDefaultMode({ sessionId: current.id, mode: "full_access", expectedVersion: current.defaultAccessModeVersion });
          }
        }
        const before = model.calls.length;
        await rt.stop("simulated_window");
        rt = await Runtime.start(config);
        await waitFor("恢复后的图片任务完成", () => rt.store.findInboundEvent(source, externalId)?.status === "done");
        const event = rt.store.findInboundEvent(source, externalId)!;
        assert.equal(event.artifactRefs.length, 1);
        const artifact = rt.store.getArtifact(event.artifactRefs[0]!)!;
        assert.equal(artifact.taskId, event.taskId);
        if (window === 2) assert.equal(rt.store.getTask(event.taskId!)!.accessMode, "confirm", "已接受任务恢复不重算后来默认模式");
        assert.equal(artifact.status, "complete");
        assert.deepEqual(rt.artifacts.read(artifact.id), PNG);
        assert.ok(JSON.stringify(model.calls.slice(before)).includes(`data:image/png;base64,${PNG.toString("base64")}`));
        assert.equal(rt.inboundMedia.getMessage(source, externalId)!.status, "bound");
        await rt.inboundMedia.stage({ ...envelope, media: [{ download: async () => { throw new Error("重复消息不能下载"); } }] });
        await rt.orchestrator!.dispatchRegisteredEvents();
        assert.equal(rt.store.listTasksBySession(main.sessionId).length, window + 1);
        assert.equal(downloads, window + 1);
        await waitFor("原入口回复发送一次", () => rt.sched.findOpBySource("owner_reply", event.id)?.status === "sent");
      }
      // 已接受后先取消、关联尚未完成：恢复只补资料与终态回执，不能再次执行。
      {
        const externalId = `${account}:${owner}:898`;
        const envelope = { source, externalId, actor: `${source}:${owner}`, body: "关联前已取消", replyTarget: target };
        rt.store.setSessionQueueState(main.sessionId, "paused", "backend_restart");
        await rt.inboundMedia.stage({ ...envelope, media: [{ download: async () => new Response(PNG, { headers: { "content-type": "image/png" } }) }] });
        const { event } = rt.store.withTx(() => rt.store.registerInboundEvent({ ...envelope, targetRole: "main" }));
        rt.inboundMedia.attachEvent(source, externalId, event.id);
        const accepted = await rt.submit({ sessionId: main.sessionId, requestId: `evt:${event.id}`,
          input: `[入站事件] 来源：${source} 外部 id：${externalId} actor：${envelope.actor}\n${envelope.body}`,
          accessMode: "confirm", agentId: "main", sourceEventId: event.id, modelSelection: rt.defaultSelection });
        await rt.cancelTask(accepted.id);
        const calls = model.calls.length;
        await rt.stop("before_terminal_source_link");
        rt = await Runtime.start(config);
        await waitFor("取消任务补关联与终态回执", () => rt.sched.findOpBySource("owner_reply", event.id)?.status === "sent");
        assert.equal(rt.store.getInboundEvent(event.id)!.taskId, accepted.id);
        assert.equal(rt.store.getInboundEvent(event.id)!.status, "failed");
        assert.equal(rt.store.getTask(accepted.id)!.status, "canceled");
        assert.equal(rt.store.getTask(accepted.id)!.accessMode, "confirm");
        assert.equal(model.calls.length, calls, "终态任务不能重新激活或重放");
        await rt.orchestrator!.dispatchRegisteredEvents();
        assert.equal(rt.sched.listOps({ limit: 100 }).items.filter((op) => op.sourceKind === "owner_reply" && op.sourceKey === event.id).length, 1);
      }
      // 提升未完成时图片损坏：明确收尾已有排队任务，不能阻塞主会话后续消息。
      rt.store.db.prepare("UPDATE sessions SET queue_state = 'paused', queue_pause_reason = 'backend_restart' WHERE id = ?").run(main.sessionId);
      const externalId = `${account}:${owner}:899`;
      const envelope = { source, externalId, actor: `${source}:${owner}`, body: "图片将损坏", replyTarget: target };
      const message = await rt.inboundMedia.stage({ ...envelope, media: [{ download: async () =>
        new Response(PNG, { headers: { "content-type": "image/png" } }) }] });
      const { event: corruptEvent } = rt.store.withTx(() => rt.store.registerInboundEvent({ ...envelope, targetRole: "main" }));
      rt.inboundMedia.attachEvent(source, externalId, corruptEvent.id);
      const pending = await rt.submit({ sessionId: main.sessionId, requestId: `evt:${corruptEvent.id}`,
        input: `[入站事件] 来源：${source} 外部 id：${externalId} actor：${envelope.actor}\n${envelope.body}`,
        accessMode: "confirm", agentId: "main", sourceEventId: corruptEvent.id, modelSelection: rt.defaultSelection });
      const staged = rt.store.listInboundMedia(message.id)[0]!;
      await rt.stop("corrupt_promotion_window");
      fs.writeFileSync(path.join(dirs.dataDir, "inbound-media", staged.fileName), "corrupted");
      rt = await Runtime.start(config);
      await waitFor("损坏图片的排队任务收尾", () => rt.store.getTask(pending.id)?.status === "canceled");
      assert.equal(rt.inboundMedia.getMessage(source, externalId)!.status, "rejected");
      assert.equal(rt.sched.findOpBySource("owner_reply", corruptEvent.id), null, "不能重复发送普通任务失败回执");
      await waitFor("损坏图片只发媒体拒绝回执", () => rt.sched.findOpBySource("inbound_event", `media:${message.id}`)?.status === "sent");
      const { event: followup } = await rt.orchestrator!.registerInboundEvent({ ...envelope, externalId: `${account}:${owner}:900`,
        body: "下一条纯文本", targetRole: "main" });
      await waitFor("后续文本任务正常运行", () => rt.store.getInboundEvent(followup.id)?.status === "done");
      await waitFor("后续文本回复", () => rt.sched.findOpBySource("owner_reply", followup.id)?.status === "sent");
      const sessionFile = rt.store.getSession(main.sessionId)!.sessionFile!;
      assert.ok(!fs.readFileSync(sessionFile, "utf8").includes(PNG.toString("base64")), "JSONL 只保留稳定引用");
      assert.equal(rt.sched.listOps({ limit: 100 }).items.filter(op => op.sourceKind === "owner_reply").length, 5);
      // 旧代次已接受但尚未关联：换拥有者后旧任务取消，不能阻塞新目标的后续消息。
      {
        const oldExternalId = `${account}:${owner}:903`;
        const oldEnvelope = { source, externalId: oldExternalId, actor: `${source}:${owner}`, body: "旧目标待关联", replyTarget: target };
        rt.store.setSessionQueueState(main.sessionId, "paused", "backend_restart");
        await rt.inboundMedia.stage({ ...oldEnvelope, media: [{ download: async () => new Response(PNG, { headers: { "content-type": "image/png" } }) }] });
        const { event: oldEvent } = rt.store.withTx(() => rt.store.registerInboundEvent({ ...oldEnvelope, targetRole: "main" }));
        rt.inboundMedia.attachEvent(source, oldExternalId, oldEvent.id);
        const oldTask = await rt.submit({ sessionId: main.sessionId, requestId: `evt:${oldEvent.id}`,
          input: `[入站事件] 来源：${source} 外部 id：${oldExternalId} actor：${oldEnvelope.actor}\n${oldEnvelope.body}`,
          accessMode: "confirm", agentId: "main", sourceEventId: oldEvent.id, modelSelection: rt.defaultSelection });
        const newOwner = String(Number(owner) + 1);
        if (source === "telegram") await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: newOwner });
        else await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq", ownerUserId: newOwner });
        await rt.stop("before_changed_target_link");
        rt = await Runtime.start(config);
        const nextConfig = source === "telegram" ? rt.telegramStore.getConfig()! : rt.qqStore.getConfig()!;
        const { event: nextEvent } = await rt.orchestrator!.registerInboundEvent({ source, externalId: `${account}:${newOwner}:904`,
          actor: `${source}:${newOwner}`, body: "新目标正常后续", targetRole: "main",
          replyTarget: { channel: source, account, chatId: newOwner, configVersion: nextConfig.configVersion } });
        await waitFor("旧排队任务被取消且新目标任务完成", () => rt.store.getTask(oldTask.id)!.status === "canceled" && rt.store.getInboundEvent(nextEvent.id)!.status === "done");
        assert.equal(rt.store.getInboundEvent(oldEvent.id)!.status, "failed");
        assert.equal(rt.sched.findOpBySource("owner_reply", oldEvent.id), null, "旧代次不产生或改发回复");
        await waitFor("新目标的后续回复发送", () => rt.sched.findOpBySource("owner_reply", nextEvent.id)?.status === "sent");
        assert.equal(rt.sched.findOpBySource("owner_reply", nextEvent.id)!.target.chatId, newOwner);
      }
    } finally {
      await rt.stop("test_end");
      await Promise.all([bot.close(), onebot.close(), model.close()]);
      await cleanupDirs(dirs);
    }
  });
}
