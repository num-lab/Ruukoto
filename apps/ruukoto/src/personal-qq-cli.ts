import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OneBotClient } from "@ruukoto/channels/qq/onebot.ts";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { parsePersonalQq, readPersonalQq, savePersonalQq } from "./personal-qq-config.ts";
import { qqMessage } from "./personal-qq-api.ts";
import { PersonalError } from "./personal-error.ts";

export async function configurePersonalQq(io: PersonalCliIO, directory: string) {
  const profile = lockPersonalProfile(directory);
  let client: OneBotClient | undefined;
  try {
    const action = await choose(io, "QQ 好友入口", ["配对并启用专用测试账号", "停用入口", "返回"]);
    if (action === 2) return;
    if (action === 1) {
      const current = readPersonalQq(profile);
      if (current) savePersonalQq(profile, { ...current, enabled: false, generation: randomUUID() });
      io.write("QQ 入口已停用；旧目标的待发回复不改发，未知发送保留供核实。\n"); return;
    }
    io.write("请先停止此 QQ 账号的其他后台，使用专用 NapCat/OneBot v11 正向 WebSocket。拥有者须与账号互为好友；群聊及群临时会话不接纳。凭据放在环境变量中。输入 /back 返回。\n");
    const endpoint = (await io.question("OneBot WebSocket 地址（本机 ws://127.0.0.1:端口 或 wss://）：")).trim();
    if (endpoint === "/back") return;
    const tokenEnv = (await io.question("OneBot 凭据环境变量名：")).trim();
    if (tokenEnv === "/back") return;
    const draft = parsePersonalQq({ version: 1, enabled: true, generation: randomUUID(), endpoint, tokenEnv, tokenDigest: "0".repeat(64), botId: "1", ownerId: "2", boundary: 0, boundaryMessageId: "0" });
    const token = process.env[draft.tokenEnv];
    if (!token || /[\r\n]/.test(token)) throw new PersonalError("qq_credentials_changed", "OneBot 凭据环境变量未设置或格式无效，请设置后重新配对。");
    const phrase = `配对 ${randomBytes(12).toString("hex")}`, candidates = new Map<string, { ownerId: string; time: number; messageId: number }>();
    const started = Date.now();
    let account: string | undefined;
    client = new OneBotClient({ endpoint: draft.endpoint, token, onEvent(event) {
      if (!account || !client?.online || client.selfId !== account || Date.now() - started >= 180_000) return;
      const message = qqMessage(event, client.selfId);
      if (message?.direct && !message.media && message.replyTo === undefined && message.text === phrase) candidates.set(message.ownerId, { ownerId: message.ownerId, time: Number(event.time), messageId: message.id });
    } });
    client.start();
    const deadline = Date.now() + 15_000;
    while (!client.online && Date.now() < deadline) await delay(50);
    if (!client.online || !client.selfId) throw new PersonalError("qq_pairing_unavailable", "QQ 登录身份或在线状态未核实，请检查 OneBot 服务和凭据后重新配对。");
    account = client.selfId;
    await io.question(`请用拥有者好友向 QQ ${account} 直接发送“${phrase}”，3 分钟内发送后按回车：`);
    if (Date.now() - started >= 180_000 || !client.online || client.selfId !== account) throw new PersonalError("qq_pairing_expired", "QQ 配对已过期或账号变化，请重新配对。");
    const owners = [...candidates.values()];
    if (!owners.length) throw new PersonalError("qq_pairing_missing", "未收到本轮好友私聊配对消息，请检查发送方式后重新配对。");
    const selected = await choose(io, "选择刚才发送配对消息的拥有者", [...owners.map(owner => `QQ 好友 ${owner.ownerId}`), "返回"]);
    if (selected === owners.length) return;
    if (Date.now() - started >= 180_000 || !client.online || client.selfId !== account) throw new PersonalError("qq_pairing_expired", "QQ 身份选择已过期，请重新配对。");
    savePersonalQq(profile, { ...draft, botId: account, ownerId: owners[selected].ownerId, tokenDigest: createHash("sha256").update(token).digest("hex"), boundary: owners[selected].time, boundaryMessageId: String(owners[selected].messageId) });
    io.write("QQ 已配对。请启动隔离后台后发送新消息；配对边界同秒及之前的消息不执行。OneBot 不提供离线补拉，断线期间请核实并重新发送未受理的消息。\n");
  } finally { await client?.stop(); profile.release(); }
}
