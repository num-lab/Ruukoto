import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
/** 图片能力检查、建任务和跨重启提升沿用同一模型选择。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { cleanupDirs, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
const VISION: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const TEXT: ModelSelection = { ...VISION, modelId: "text-model" };
const TOKEN = "123456:MODEL-PINNING-SECRET";

test("图片检查、提交和重启间模型配置变化：沿用钉定选择或在建任务前拒绝", async () => {
  const { dirs } = await makeTestDirs("media-model-pinning", 0);
  const model = new MockModelServer(() => ({ kind: "text", text: "图片已收到" }));
  await writeModelsJson(dirs, await model.start());
  const file = path.join(dirs.agentDir, "models.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  const vision = catalog.providers.mock.models[0];
  vision.input.push("image");
  catalog.providers.mock.models.push({ ...vision, id: TEXT.modelId, name: "Text only", input: ["text"] });
  fs.writeFileSync(file, JSON.stringify(catalog));
  const bot = new FakeBotApi({ token: TOKEN });
  const apiBase = await bot.start();
  // 使用持久默认，允许 setDefaultModel 在运行期间实际改变 defaultSelection。
  const config: RuntimeConfig = {
    product: personalProduct.runtime, dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", toolFactory: createMockTools, telegram: { pollTimeoutSec: 1, backoffMs: 30 },
    scheduler: { tickMs: 0, sendTimeoutMs: 1000 } };
  let rt = await Runtime.start(config);
  let releaseCheck = () => {};
  try {
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: TOKEN });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" });
    await rt.telegramSetEnabled(true);
    await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
    const main = rt.store.getAgentRole("main")!;
    const target = { channel: "telegram", account: "123456", chatId: "42", configVersion: rt.telegramStore.getConfig()!.configVersion };
    const envelope = (id: number) => ({ source: "telegram", externalId: `123456:42:${id}`, actor: "telegram:42", body: `图片 ${id}`, replyTarget: target });
    const stage = (id: number) => rt.inboundMedia.stage({ ...envelope(id), media: [{ download: async () =>
      new Response(PNG, { headers: { "content-type": "image/png" } }) }] });
    const setDefault = (selection: ModelSelection) => rt.setDefaultModel({ ...selection, expectedRevision: rt.getModelConfig().revision });

    const originalResolve = rt.modelCatalog.resolve.bind(rt.modelCatalog);
    let firstCheck = true;
    let checkEntered = false;
    const blocked = new Promise<void>((resolve) => { releaseCheck = resolve; });
    rt.modelCatalog.resolve = async (selection) => {
      const selected = await originalResolve(selection);
      if (firstCheck) {
        firstCheck = false;
        assert.deepEqual(selection, VISION);
        checkEntered = true;
        await blocked;
      }
      return selected;
    };
    await stage(801);
    const { event: first } = await rt.orchestrator!.registerInboundEvent({ ...envelope(801), targetRole: "main" });
    rt.inboundMedia.attachEvent("telegram", first.externalId, first.id);
    await waitFor("图片能力检查等待", () => checkEntered);
    await setDefault(TEXT);
    assert.deepEqual(rt.defaultSelection, TEXT);
    assert.equal(rt.store.listTasksBySession(main.sessionId).length, 0, "检查完成前没有普通任务");
    releaseCheck();
    await waitFor("原视觉选择完成任务", () => rt.store.getInboundEvent(first.id)?.status === "done");
    const firstTask = rt.store.getTask(rt.store.getInboundEvent(first.id)!.taskId!)!;
    assert.deepEqual(firstTask.modelSelection, VISION);
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0]!.raw.model, VISION.modelId);
    assert.ok(JSON.stringify(model.calls[0]).includes(`data:image/png;base64,${PNG.toString("base64")}`));
    rt.scheduler!.kickSender();
    await waitFor("首次回复已发送", () => rt.sched.findOpBySource("owner_reply", first.id)?.status === "sent");

    await setDefault(VISION);
    rt.store.db.prepare("UPDATE sessions SET queue_state = 'paused', queue_pause_reason = 'backend_restart' WHERE id = ?").run(main.sessionId);
    await stage(802);
    const { second, queued } = await rt.orchestrator!.serial(async () => {
      const { event: second } = rt.store.withTx(() => rt.store.registerInboundEvent({ ...envelope(802), targetRole: "main" }));
      rt.inboundMedia.attachEvent("telegram", second.externalId, second.id);
      const queued = await rt.submit({ sessionId: main.sessionId, requestId: `evt:${second.id}`,
        input: `[入站事件] 来源：telegram 外部 id：${second.externalId} actor：telegram:42\n${second.body}`,
        accessMode: "confirm", agentId: "main", sourceEventId: second.id, modelSelection: VISION });
      assert.equal(rt.store.getInboundEvent(second.id)!.taskId, null, "播种建任务完成、事件尚未回填的窗口");
      await setDefault(TEXT);
      return { second, queued };
    });
    const current = rt.store.getSession(main.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: current.id, mode: "full_access", expectedVersion: current.defaultAccessModeVersion });
    await rt.stop("before_media_promotion");
    rt = await Runtime.start(config);
    assert.deepEqual(rt.defaultSelection, TEXT, "重启确实使用后来保存的仅文本默认模型");
    await waitFor("已建任务按原视觉模型恢复", () => rt.store.getInboundEvent(second.id)?.status === "done");
    const recovered = rt.store.getInboundEvent(second.id)!;
    assert.equal(recovered.taskId, queued.id);
    assert.deepEqual(rt.store.getTask(queued.id)!.modelSelection, VISION);
    assert.equal(rt.store.getTask(queued.id)!.accessMode, "confirm", "恢复补关联不改变已接收任务模式");
    assert.equal(rt.store.listTasksBySession(main.sessionId).length, 2, "原请求键恢复不能重复建任务");
    assert.equal(recovered.artifactRefs.length, 1);
    assert.equal(model.calls.length, 2, "未绑定任务恢复只发一次模型请求");
    assert.equal(model.calls[1]!.raw.model, VISION.modelId);
    assert.ok(JSON.stringify(model.calls[1]).includes(`data:image/png;base64,${PNG.toString("base64")}`));
    rt.scheduler!.kickSender();
    await waitFor("恢复任务回复已发送", () => rt.sched.findOpBySource("owner_reply", second.id)?.status === "sent");

    // 同一模型在 prepare 后失去视觉能力：submit 必须按当前目录复核，不能先建任务。
    await setDefault(VISION);
    const currentResolve = rt.modelCatalog.resolve.bind(rt.modelCatalog);
    let resolves = 0;
    rt.modelCatalog.resolve = async (selection) => {
      assert.deepEqual(selection, VISION);
      const selected = await currentResolve(selection);
      return { ...selected, input: ++resolves === 1 ? ["text", "image"] : ["text"] };
    };
    const rejectedMedia = await stage(803);
    const { event: third } = rt.store.withTx(() => rt.store.registerInboundEvent({ ...envelope(803), targetRole: "main" }));
    rt.inboundMedia.attachEvent("telegram", third.externalId, third.id);
    await rt.orchestrator!.dispatchRegisteredEvents();
    assert.equal(resolves, 2, "prepare 看见视觉能力，submit 随后看见仅文本能力");
    assert.equal(rt.store.findTaskByRequest(main.sessionId, `evt:${third.id}`), null, "提交复核失败在 Task 插入前阻断");
    assert.equal(rt.store.getInboundEvent(third.id)!.status, "registered", "重派仍使用原事件键");
    assert.equal(rt.inboundMedia.getMessageById(rejectedMedia.id)!.status, "ready");
    assert.equal(model.calls.length, 2, "能力变化不能产生缺图模型请求");
    await rt.orchestrator!.dispatchRegisteredEvents();
    assert.equal(rt.store.getInboundEvent(third.id)!.status, "failed");
    assert.equal(rt.inboundMedia.getMessageById(rejectedMedia.id)!.reason, "image_input_unsupported");
    assert.equal(rt.store.listTasksBySession(main.sessionId).length, 2);
    const receiptKey = `media:${rejectedMedia.id}`;
    await waitFor("能力不足固定回执发送", () => rt.sched.findOpBySource("inbound_event", receiptKey)?.status === "sent");
    const receipt = rt.sched.findOpBySource("inbound_event", receiptKey)!;
    assert.equal(receipt.text, "[ruukoto] 当前模型不支持图片输入，这条图片消息未执行。请在配置中选择支持图片的模型后重新发送。");
    await rt.orchestrator!.dispatchRegisteredEvents();
    assert.equal(bot.sends.filter((send) => send.text === receipt.text).length, 1, "重派不能重复发送固定回执");
    assert.equal(model.calls.length, 2);
  } finally {
    releaseCheck();
    await rt.stop("test_end");
    await Promise.all([bot.close(), model.close()]);
    await cleanupDirs(dirs);
  }
});
