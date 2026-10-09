/**
 * smoke-09（agent-direction issue 09）远端后端侧小工具：以 ruukoto-backend 身份运行
 * （orchestrator 经 `sudo -n -u ruukoto-backend` 调用），只做五类窄操作：
 *   handshake  连接隔离后台控制面并握手（连通性自检）
 *   configure  完成 QQ 私聊配置（凭据 + endpoint + owner + 启用），等待在线
 *   qqonline   轮询 QQ 私聊在线状态（配置生效核实）
 *   query      对隔离数据目录的 ruukoto.db 只读 SELECT（账本/审批/任务证据）
 *   resume     恢复崩溃后暂停的主会话队列（E 阶段恢复前提；仅此一个控制面写操作）
 * 不持有提权：root 侧证据由 orchestrator（ssh 登录账户 + sudo -n）直接读取。
 * 运行：node_modules/.bin/tsx .scratch/agent-direction/smoke09-backendctl.mts <action> '<json>'
 */

import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { ControlClient } from "../../src/control/client.ts";
import { readOwnerToken } from "../../src/control/owner-token.ts";

const [action, payloadRaw] = process.argv.slice(2);
const payload = payloadRaw ? JSON.parse(payloadRaw) : {};
const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

async function connect(controlDir: string): Promise<ControlClient> {
  const client = await ControlClient.connect(path.join(controlDir, "control.sock"), 2_000);
  const token = readOwnerToken(controlDir);
  if (!token) throw new Error("缺少拥有者令牌");
  await client.authenticate(token);
  await client.handshake();
  return client;
}

if (action === "handshake") {
  const client = await connect(String(payload.controlDir));
  client.close();
  out({ ok: true });
} else if (action === "configure") {
  const { controlDir, url, secret, selfId, owner } = payload as Record<string, string>;
  const client = await connect(controlDir);
  await client.request("add_credential", { name: "qq-smoke", host: new URL(url).host, header: "authorization", purpose: "qq_onebot", secret });
  await client.request("qq_configure", { endpoint: url, self_id: selfId, credential: "qq-smoke", owner_user_id: owner });
  await client.request("qq_set_enabled", { enabled: true });
  const deadline = Date.now() + 30_000;
  let status: any = null;
  do {
    status = await client.request<any>("qq_status");
    if (status.online) break;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  client.close();
  out({ online: status?.online === true, status });
} else if (action === "qqonline") {
  const client = await connect(String(payload.controlDir));
  const deadline = Date.now() + 30_000;
  let status: any = null;
  do {
    status = await client.request<any>("qq_status");
    if (status.online) break;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  client.close();
  out({ online: status?.online === true, status });
} else if (action === "resume") {
  const client = await connect(String(payload.controlDir));
  try {
    await client.request("resume_queue", { session_id: String(payload.sessionId) });
  } finally {
    client.close();
  }
  out({ ok: true });
} else if (action === "query") {
  const { db, sql, params = [] } = payload as { db: string; sql: string; params?: unknown[] };
  if (typeof sql !== "string" || !/^\s*select\b/i.test(sql)) throw new Error("只允许只读 SELECT");
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    out({ rows: d.prepare(sql).all(...(params as any[])) });
  } finally {
    d.close();
  }
} else {
  throw new Error(`未知动作 ${String(action)}`);
}
