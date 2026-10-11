import type { NotifyTarget } from "./types.ts";

/**
 * 固定目标逐项核对（渠道/账号/chat/配置版本）；任一字段变化即另一代次，
 * 旧目标上钉版的消息、批准与发送操作一律失效，不改发。
 */
export function sameTarget(a: NotifyTarget, b: NotifyTarget | null | undefined): boolean {
  return !!b && a.channel === b.channel && a.account === b.account && a.chatId === b.chatId && a.configVersion === b.configVersion;
}

export const QQ_PRIVATE_SOURCE = "qq_private";
export const TELEGRAM_SOURCE = "telegram";
