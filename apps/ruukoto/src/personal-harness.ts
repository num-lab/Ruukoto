import * as path from "node:path";
import { closeSync, existsSync, openSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, AssistantEntry, createRegistry, defineDoc, defineExtension, Harness, ROOT_CONVERSATION_ID, section, type Cursor, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Provider } from "@earendil-works/pi-ai/models";
import { PersonalError } from "./personal-error.ts";
import { recordedModels, type RequestEvidence } from "./personal-model.ts";
import { lockPersonalProfile, PERSONAL_FORMAT, type PersonalProfileLock } from "./personal-profile.ts";

const context = BACKGROUND_CONTEXT;
export const PersonalFormatDoc = defineDoc({ kind: "ruukoto.format", scope: "session", version: 1, initial: () => ({ ...PERSONAL_FORMAT }) });
export const PERSONAL_PROMPT = "你是拥有者的个人助手。根据已有对话回答；当前未提供外部操作工具，需要执行外部操作时说明尚不可用。";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md
export async function openPersonalHarness(options: ({ directory: string; profile?: never } | { profile: PersonalProfileLock; directory?: never }) & {
  provider: Provider;
  modelId: string;
  openStorage?: (filename: string) => Promise<Storage>;
  beforeUnlock?: () => Promise<void>;
}) {
  const lock = options.profile ?? lockPersonalProfile(options.directory);
  let harness: Harness | undefined;
  let storage: Storage | undefined;
  let unlocked: Promise<void> | undefined;
  try {
    if (!options.provider.getModels().some(model => model.id === options.modelId)) throw new PersonalError("model_unavailable", "所选模型不在个人模型配置中，请重新配置后启动。");
    const registry = createRegistry();
    const personal = defineExtension({ name: "personal", sections: [section("personal", () => PERSONAL_PROMPT, { tag: false })] });
    registry.install(personal);
    const record = async (evidence: RequestEvidence) => {
      if (!harness) throw new PersonalError("model_source_missing", "模型请求缺少已打开的个人会话，已停止请求。");
      await harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.model-request", data: evidence }), context);
    };
    const filename = path.join(lock.directory, "personal.sqlite");
    const existing = existsSync(filename);
    closeSync(openSync(filename, "a", 0o600));
    storage = await (options.openStorage ?? openNodeSqliteStorage)(filename);
    const formatRecord = await storage.findDocument({ kind: PersonalFormatDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const saved = formatRecord && await storage.document(formatRecord.id, "current", context);
    if ((existing && !saved) || (saved && (saved.version !== PersonalFormatDoc.definition.version || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)))) {
      throw new PersonalError("extension_version", "个人业务扩展版本不受支持，已停止恢复，请使用与档案对应的程序。");
    }
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanConversations({}, 256, cursor, context);
      for (const conversation of page.items) {
        const record = await storage.findDocument({ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId: conversation.id } }, "current", context);
        const agent = record && await storage.document(record.id, "current", context);
        const extensions = agent?.value.extensions;
        if (!agent || agent.version !== AgentDoc.definition.version || !Array.isArray(extensions) || extensions.some(name => typeof name !== "string" || !registry.snapshot().extension(name))) {
          throw new PersonalError("extension_missing", "会话依赖的个人扩展缺失，已停止恢复，请使用与档案对应的程序。");
        }
      }
      cursor = page.next;
    } while (cursor);
    harness = await Harness.open(storage, { models: recordedModels(options.provider, record), registry, onReport: () => process.stderr.write("[ruukoto:personal] 持久执行出现错误，请查询状态并检查档案；未自动重启。\n") }, context);
    // Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
    unlocked = harness.closed.then(async () => { if (options.beforeUnlock) await options.beforeUnlock(); lock.release(); });
    void unlocked.catch(() => process.stderr.write("[ruukoto:personal] 本机管理接口未能停止，实例锁仍保留；请检查后台并核实停止。\n"));
    const inspection = await harness.inspect(context);
    if (inspection.tasks.some(task => task.state.kind === "blocked" || registry.snapshot().task(task.record.kind)?.definition.version !== task.record.version)) throw new PersonalError("task_version", "档案中有当前程序无法恢复的任务，已停止恢复，请使用对应版本。");
    await harness.commit(tx => tx.doc(PersonalFormatDoc), context);
    const main = await harness.root(context, { agent: { model: { provider: options.provider.id, modelId: options.modelId }, thinkingLevel: "off", extensions: [personal], tools: [] } });
    const agent = await main.agent(context);
    if (agent.model?.provider !== options.provider.id || agent.model.modelId !== options.modelId) {
      if (inspection.tasks.length || inspection.submissions.length) throw new PersonalError("model_changed_pending", "个人档案仍有未完成输入，模型已变更；请恢复原模型完成处理后再切换。");
      await main.configure({ model: { provider: options.provider.id, modelId: options.modelId } }, context);
    }
    const instance = harness;
    instance.resume();
    return {
      harness: instance,
      main,
      async submit(input: string, requestId: string) {
        return main.submit({ type: "input", content: input, requestId, whenBusy: "followUp" }, context);
      },
      async answer(input: string, requestId: string) {
        const submission = await main.submit({ type: "input", content: input, requestId, whenBusy: "followUp" }, context);
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.type !== "input") throw new PersonalError("input_unanswered", "本次输入未获得完整回答，请查看工作状态后决定下一步。");
        const entry = await main.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
        const message = entry?.model?.[0];
        if (message?.role !== "assistant") throw new PersonalError("answer_missing", "已结束输入的回答记录缺失，请保留档案并检查存储。");
        return message.content.filter(part => part.type === "text").map(part => part.text).join("");
      },
      async close() { await instance.close(context); await unlocked; },
    };
  } catch (error) {
    try {
      if (harness) { await harness.close(context); await unlocked; }
      else if (storage) await storage.close(context);
    } catch {
      // 保留启动的原异常；管理接口清理失败时仍保留锁，避免下一实例覆盖旧 socket。
      process.stderr.write("[ruukoto:personal] 初始化清理失败，已停止启动；请保留档案并检查存储。\n");
    } finally { if (!unlocked) lock.release(); }
    throw error;
  }
}

export type PersonalHarness = Awaited<ReturnType<typeof openPersonalHarness>>;
