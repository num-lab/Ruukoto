import { isDeepStrictEqual } from "node:util";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { defineEntry, ROOT_CONVERSATION_ID, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { personalImDeliveryRecord, PersonalImDeliveriesDoc, PersonalImDeliveryDoc, requestPersonalImDelivery, type PersonalImDeliveryInput, type PersonalImDeliveryRecord } from "./personal-im-delivery.ts";
import { PersonalTelegramDisplayDoc } from "./personal-telegram-display-records.ts";
import { PERSONAL_TELEGRAM_CUA_VIEW, PersonalTelegramReceiptDoc, samePersonalEntry, type PersonalEntryIdentity, type TelegramControlInput } from "./personal-telegram-records.ts";
import { telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { mcpOperation, mcpOriginal, personalMcpRecoveryObservation, type PersonalCuaRecoveryBinding } from "./personal-mcp.ts";
import { personalImControlAccepted } from "./personal-recovery-claims.ts";
import type { PersonalArtifact } from "./personal-artifacts.ts";

type ImageRequest = { v: 1; requestId: string; source: PersonalEntryIdentity; messageId: number; display: string; operation: TaskId; admission: EntryId; occurrence: EntryId; continuation: PersonalCuaRecoveryBinding; observation: EntryId; binding: JsonValue; images: PersonalArtifact[] };
export const PersonalTelegramCuaImages = defineEntry<ImageRequest>("ruukoto.telegram-cua-images");
const invalid = () => new PersonalError("telegram_cua_images_invalid", "原电脑截图读取无法核实，请从原卡片重新查看现场。");
const currentScene = async (tx: Tx, operation: TaskId) => {
  const value = await mcpOperation(tx, operation), scene = value.takeover ?? value.cua?.recovery;
  const continuation: PersonalCuaRecoveryBinding = { ...(value.takeover ? { pause: value.takeover.paused } : {}), ...(scene?.observation ? { observation: scene.observation.entry } : {}), ...(scene?.accepted ? { accepted: scene.accepted } : {}), ...(value.cua ? { execution: value.cua.execution } : {}), ...(value.cuaLaunches ? { launches: value.cuaLaunches.map(launch => launch.entry) } : {}) };
  return { value, scene, continuation };
};
const imageOutputs = (request: ImageRequest) => request.images.map(image => ({ recovery: { requestId: request.requestId, image: image.id } }));
const imageText = (count: number) => `原电脑现场的${count}张截图将在本消息后发送。请打开核对，再从现场卡片接受；截图发送结果未知时不会自动重发，可明确选择再次查看。`;

async function originalRequest(tx: Tx, input: PersonalImDeliveryInput) {
  const key = input.key.slice("telegram-cua-images:".length), receipt = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
  if (!input.key.startsWith("telegram-cua-images:") || !receipt?.cuaImages || !receipt.control || !receipt.direct || receipt.platform || receipt.permission || receipt.submissionId !== undefined || receipt.selection || receipt.cuaAction || !await personalImControlAccepted(tx, receipt)) throw invalid();
  const entry = await tx.entry(PersonalTelegramCuaImages, receipt.cuaImages.entry), request = entry?.data, display = request && (await tx.doc(PersonalTelegramDisplayDoc, request.display, null)).display, selected = await telegramSelection(tx, receipt);
  if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || entry.model !== undefined || entry.byTaskId !== undefined || !request || request.v !== 1 || !receipt.accepted || entry.id >= receipt.accepted || receipt.accepted >= receipt.taskId || request.requestId !== receipt.requestId || receipt.content !== PERSONAL_TELEGRAM_CUA_VIEW || request.messageId !== receipt.messageId || !samePersonalEntry(request.source, receipt) || !samePersonalEntry(input.source, request.source) || input.messageId !== request.messageId || !receipt.multipart || receipt.multipart.key !== input.key || !display?.target || display.admission >= entry.id || !display.buttons.some(button => button.action === PERSONAL_TELEGRAM_CUA_VIEW) || !samePersonalEntry(display.source, request.source) || selected?.requestId !== request.display || display.target.family !== "mcp" || display.target.operation !== request.operation || display.target.admission !== request.admission || display.target.occurrence !== request.occurrence || !isDeepStrictEqual(display.binding, request.binding) || !isDeepStrictEqual(display.continuation, request.continuation) || request.continuation.observation !== request.observation) throw invalid();
  await mcpOriginal(tx, request.operation, { ...request.source, requestId: key }, false);
  const operation = await mcpOperation(tx, request.operation), observation = await personalMcpRecoveryObservation(tx, request.operation, request.observation);
  if (operation.admission !== request.admission || observation.entry >= display.admission || observation.pause !== request.continuation.pause || !isDeepStrictEqual(observation.images, request.images) || !request.images.length || request.images.length > 4 || new Set(request.images.map(image => image.id)).size !== request.images.length || input.text !== imageText(request.images.length) || receipt.reply !== input.text || input.keyboard || input.retrieval || !isDeepStrictEqual(input.outputs, imageOutputs(request))) throw invalid();
  const delivery = await personalImDeliveryRecord(tx, receipt.multipart);
  if (delivery.parent !== undefined || !isDeepStrictEqual(delivery.input, input) || delivery.admission <= entry.id || delivery.admission >= receipt.accepted) throw invalid();
  return { request, receipt, observation, delivery };
}

// Note: See .agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md
export async function personalTelegramCuaImageControl(tx: Tx, value: TelegramControlInput, selected?: Awaited<ReturnType<typeof telegramSelection>>) {
  if (value.content !== PERSONAL_TELEGRAM_CUA_VIEW || value.platform || !value.direct || !await telegramSourceActive(tx, value)) return false;
  const prior = selected ?? await telegramSelection(tx, value), display = prior && (await tx.doc(PersonalTelegramDisplayDoc, prior.requestId, null)).display;
  if (!display?.target || display.target.family !== "mcp" || prior?.selection?.kind !== "mcp" || !display.buttons.some(button => button.action === PERSONAL_TELEGRAM_CUA_VIEW) || !samePersonalEntry(display.source, value) || !display.continuation?.observation) { value.reply = "请从原电脑现场卡片选择查看截图。"; return true; }
  const { value: operation, scene, continuation } = await currentScene(tx, display.target.operation), observation = scene?.observation;
  await mcpOriginal(tx, operation.operation, value);
  if (!observation || !isDeepStrictEqual(continuation, display.continuation) || !observation.images.length || observation.images.length > 4) { value.reply = "原电脑现场已变化，请重新观察后查看。"; return true; }
  const request: ImageRequest = copyJson({ v: 1, requestId: value.requestId, source: { botId: value.botId, ownerId: value.ownerId, generation: value.generation }, messageId: value.messageId, display: display.key, operation: operation.operation, admission: display.target.admission, occurrence: display.target.occurrence, binding: display.binding!, continuation: display.continuation, observation: observation.entry, images: observation.images }) as ImageRequest;
  value.cuaImages = { entry: (await tx.appendEntry(PersonalTelegramCuaImages, ROOT_CONVERSATION_ID, { data: request })).id };
  value.reply = imageText(request.images.length);
  value.multipart = await requestPersonalImDelivery(tx, { key: `telegram-cua-images:${value.requestId}`, source: request.source, messageId: value.messageId, text: value.reply, outputs: imageOutputs(request) });
  return true;
}

export async function authorizePersonalTelegramCuaImages(tx: Tx, input: PersonalImDeliveryInput) {
  const { request, observation } = await originalRequest(tx, input), { scene, continuation } = await currentScene(tx, request.operation);
  return await telegramSourceActive(tx, request.source) && isDeepStrictEqual(continuation, request.continuation) && scene?.observation?.entry === request.observation && isDeepStrictEqual(scene.observation.execution, observation.execution);
}

export async function verifyPersonalTelegramCuaImageDelivery(tx: Tx, input: PersonalImDeliveryInput) { return originalRequest(tx, input); }

export async function personalTelegramCuaImage(tx: Tx, requestId: string, imageId: string, source: PersonalEntryIdentity) {
  const receipt = (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt;
  if (!receipt?.multipart || !samePersonalEntry(receipt, source)) throw invalid();
  const delivery = await personalImDeliveryRecord(tx, receipt.multipart), { request } = await originalRequest(tx, delivery.input);
  if (!await authorizePersonalTelegramCuaImages(tx, delivery.input)) throw new PersonalError("cua_observation_stale", "原电脑现场已变化，旧截图没有再次发送。");
  const image = request.images.find(image => image.id === imageId);
  if (!image || image.partial || image.bytes > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(image.mime)) throw new PersonalError("output_partial", "原截图没有完整保存，无法完整发送。");
  return { name: `computer-scene-${request.images.indexOf(image) + 1}.${({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[image.mime]}`, artifact: { ...image, identity: { ...image.identity } } };
}

async function deliveredBefore(tx: Tx, delivery: PersonalImDeliveryRecord, before?: EntryId) {
  for (const part of delivery.parts) {
    if (before === undefined) { if (part.state !== "sent") return false; continue; }
    const id = part.observations.filter(id => id < before).at(-1), entry = id && await tx.entry(id), data = entry && entry.data;
    if (!entry || entry.kind !== "ruukoto.im-delivery-observation" || !data || typeof data !== "object" || Array.isArray(data) || !isDeepStrictEqual(data.ref, delivery.ref) || data.admission !== delivery.admission || data.index !== part.index || data.state !== "sent" || typeof data.platformMessageId !== "string" || !data.platformMessageId) return false;
  }
  return true;
}

export async function personalTelegramCuaImagesDelivered(tx: Tx, operation: TaskId, observation: EntryId, source: PersonalEntryIdentity, before?: EntryId) {
  for (const key of (await tx.doc(PersonalImDeliveriesDoc)).keys) {
    if (!key.startsWith("telegram-cua-images:")) continue;
    const saved = (await tx.doc(PersonalImDeliveryDoc, key, null)).delivery;
    if (!saved) throw invalid();
    if (!samePersonalEntry(saved.input.source, source)) continue;
    const { request, delivery } = await originalRequest(tx, saved.input);
    if (request.operation === operation && request.observation === observation && delivery.parts.filter(part => part.kind === "output").length === request.images.length && await deliveredBefore(tx, delivery, before)) return true;
  }
  return false;
}

export async function verifyPersonalTelegramCuaImages(tx: Tx, value: TelegramControlInput) {
  if (!value.cuaImages) return;
  if (!value.multipart) throw invalid();
  await originalRequest(tx, (await personalImDeliveryRecord(tx, value.multipart)).input);
}
