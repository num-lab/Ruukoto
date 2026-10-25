import { randomUUID } from "node:crypto";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { executePersonalSettings, personalSettingsMessage, savePersonalSettings } from "./personal-settings.ts";
import { parsePersonalTelegram } from "./personal-telegram-config.ts";
import { parsePersonalQq } from "./personal-qq-config.ts";
import { PersonalError } from "./personal-error.ts";
import type { personalImPairing } from "./personal-im-pairing.ts";

type PairingView = Awaited<ReturnType<ReturnType<typeof personalImPairing>["read"]>>;
export async function configurePersonalIm(io: PersonalCliIO, directory: string, platform: "telegram" | "qq") {
  const title = platform === "qq" ? "QQ" : "Telegram";
  const action = await choose(io, `${title} 入口`, [platform === "qq" ? "配对并启用专用测试账号" : "配对并启用专用 bot", "停用入口", "返回"]);
  if (action === 2) return;
  const view = await executePersonalSettings(directory, { v: 1, op: "settings.read" }) as { profile: { directory: string; id: string }; online: boolean; revisions: Record<string, string>; telegram: unknown; qq: unknown };
  if (action === 1) {
    const current = view[platform];
    if (!current) { io.write(`${title} 尚未配置入口。\n`); return; }
    const config = platform === "qq" ? parsePersonalQq(current) : parsePersonalTelegram(current);
    const result = await savePersonalSettings(directory, view, view.revisions[platform], { kind: "config.save", target: platform, value: { ...config, enabled: false, generation: randomUUID() } });
    io.write(`${personalSettingsMessage(result)}旧入口待发回复不改发，已开始的未知发送保留。\n`); return;
  }
  if (!view.online) throw new PersonalError("im_pairing_online_required", "入口配对需要原后台在线，以后台实际凭据核实身份；当前未验证。离线可保存或停用已配置入口，启动与保存分开执行。");
  io.write(`请核实${title}专用账号没有其他后台接收消息。凭据须已在后台环境中配置；输入 /back 返回。\n`);
  const endpoint = (await io.question(platform === "qq" ? "OneBot WebSocket 地址：" : "Telegram API 地址（默认 https://api.telegram.org）：")).trim();
  if (endpoint === "/back") return;
  const tokenEnv = (await io.question(platform === "qq" ? "OneBot 凭据环境变量名：" : "Bot 凭据环境变量名：")).trim();
  if (tokenEnv === "/back") return;
  if (platform === "telegram" && await choose(io, "接管专用 bot 并确认旧积压，边界及之前消息不执行", ["返回", "确认接管并开始配对"]) === 0) return;
  const started = await executePersonalSettings(directory, { v: 1, op: "im.pair-start", id: randomUUID(), platform, endpoint: endpoint || "https://api.telegram.org", tokenEnv }) as PairingView;
  try {
    await io.question(`请用拥有者${platform === "qq" ? "好友" : "私聊"}向 ${title} ${started.accountId ?? "专用账号"} 直接发送“${started.phrase}”，3 分钟内发送后按回车：`);
    const current = await executePersonalSettings(directory, { v: 1, op: "im.pair-read", id: started.id }) as PairingView;
    if (current.phase !== "waiting" || !current.candidates.length) throw new PersonalError("im_pairing_missing", "后台未收到本轮直接发送的配对消息，请核实平台账号和发送方式后重新配对。");
    const selected = await choose(io, "选择刚才发送配对消息的拥有者", [...current.candidates.map(candidate => `${candidate.name}（${candidate.ownerId}）`), "返回"]);
    if (selected === current.candidates.length) return;
    const confirmed = await executePersonalSettings(directory, { v: 1, op: "im.pair-confirm", id: started.id, ownerId: current.candidates[selected].ownerId }) as PairingView;
    if (!confirmed.config || confirmed.phase !== "confirmed") throw new PersonalError("im_pairing_unverified", "后台配对尚未核实，未保存入口；请查询原配对状态。");
    const receipt = await savePersonalSettings(directory, confirmed, started.revision, { kind: "config.save", target: platform, value: confirmed.config });
    io.write(`${personalSettingsMessage(receipt)}请发送新消息；旧入口的待发回复不改发，完整历史保留。\n`);
  } finally {
    try { await executePersonalSettings(directory, { v: 1, op: "im.pair-cancel", id: started.id }); }
    catch { io.write("原配对会话未能结束，请查询当前入口；后台会在配对期限结束后恢复原接收状态。\n"); }
  }
}
