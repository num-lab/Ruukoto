import * as http from "node:http";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { PersonalError } from "./personal-error.ts";
import { personalRemoteDirectory, type PersonalRemoteCredentialReceipt } from "./personal-remote-auth.ts";
import { initializePersonalRemote, parsePersonalRemoteConfig, readPersonalRemoteConfig, startPersonalRemote } from "./personal-remote.ts";
import { personalSettingsDirectoryIdentity } from "./personal-settings.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function personalRemoteAdmin<T>(route: string, body?: unknown, home?: () => string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path.join(personalRemoteDirectory(home), "admin.sock"), method: body === undefined ? "GET" : "POST", path: route, headers: { "content-type": "application/json", connection: "close" } });
    request.setTimeout(10_000, () => request.destroy());
    request.once("error", () => reject(new PersonalError("remote_admin_unavailable", "本机远程管理入口不可达，请先启动固定remote服务；原PA后台与凭据保持。")));
    request.once("response", response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) response.destroy(); else chunks.push(chunk); });
      response.once("error", () => reject(new PersonalError("remote_admin_unverified", "本机管理应答中断，请核实原配对或撤销状态；未自动重试。")));
      response.once("end", () => {
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { reject(new PersonalError("remote_admin_unverified", "本机管理应答无效，请检查原remote服务；未自动重试。")); return; }
        if (!object(value) || value.v !== 1 || value.product !== "ruukoto" || typeof value.ok !== "boolean") { reject(new PersonalError("remote_admin_unverified", "本机管理协议不符，请更新remote服务。")); return; }
        if (!value.ok) { reject(new PersonalError(typeof value.code === "string" ? value.code : "remote_admin_unverified", typeof value.message === "string" ? value.message : "本机管理结果未核实，请检查原状态。")); return; }
        resolve(value.result as T);
      });
    });
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function personalRemoteMenu(directory: string, io: PersonalCliIO, home?: () => string): Promise<void> {
  while (true) {
    const action = await choose(io, "远程桌面", ["初始化连接绑定", "开启桌面配对", "取消配对窗口", "查看已配对桌面", "撤销桌面凭据", "确认已变化的绑定", "诊断原远程状态", "返回"]);
    if (action === 7) return;
    try {
      if (action === 0) {
        let previous: ReturnType<typeof readPersonalRemoteConfig> | undefined;
        try { previous = readPersonalRemoteConfig(home); }
        catch (error) { if (!(error instanceof PersonalError) || error.code !== "remote_config_invalid") throw error; }
        const values: string[] = [];
        for (const [prompt, fallback] of [["HTTPS地址", previous?.origin], ["Tailscale拥有者登录名", previous?.owner], ["原个人档案目录", previous?.profile.directory ?? directory]]) {
          const answer = (await io.question(`${prompt}${fallback ? `（默认 ${fallback}）` : ""}：`)).trim();
          if (answer === "/back") break;
          values.push(answer || fallback || "");
        }
        if (values.length !== 3) continue;
        const source = values[2];
        if (!path.isAbsolute(source) || path.resolve(source) !== source) throw new PersonalError("remote_config_invalid", "请选择原个人档案的规范绝对目录；未创建其他档案。");
        const profile = personalSettingsDirectoryIdentity(source);
        const config = parsePersonalRemoteConfig({ v: 1, origin: values[0].replace(/\/$/, ""), owner: values[1], profile });
        io.write(`绑定 ${config.origin} → ${profile.directory}，拥有者 ${config.owner}。变更绑定会持久撤销旧配对；初始化期间remote服务须停止。\n`);
        if (await choose(io, "确认绑定", ["初始化此绑定", "返回"]) !== 0) continue;
        await initializePersonalRemote(config, home);
        io.write(`绑定已保存。请管理员独立启动remote服务，并将Tailscale Serve代理指向 ${path.join(personalRemoteDirectory(home), "remote.sock")}；admin.sock仅供本机管理。\n`);
      } else if (action === 1) {
        const window = await personalRemoteAdmin<{ code: string; expiresAt: number }>("/pair/open", {}, home);
        io.write(`配对码：${window.code}\n有效至 ${new Date(window.expiresAt).toLocaleTimeString()}。请在自己的桌面输入；配对码只授予一次，勿转发。\n`);
      } else if (action === 2) {
        await personalRemoteAdmin("/pair/cancel", {}, home); io.write("配对窗口已关闭。\n");
      } else if (action === 3 || action === 4) {
        const credentials = await personalRemoteAdmin<PersonalRemoteCredentialReceipt[]>("/credentials", undefined, home);
        if (!credentials.length) { io.write("尚无配对桌面。\n"); continue; }
        const labels = credentials.map(item => `${item.label} · ${item.status === "active" ? "有效" : "已撤销"} · ${new Date(item.createdAt).toLocaleString()}`);
        if (action === 3) { for (const label of labels) io.write(`${label}\n`); continue; }
        const active = credentials.filter(item => item.status === "active");
        if (!active.length) { io.write("没有有效凭据可撤销。\n"); continue; }
        const selected = await choose(io, "撤销哪一个桌面？", [...active.map(item => `${item.label} · ${new Date(item.createdAt).toLocaleString()}`), "返回"]);
        if (selected === active.length) continue;
        await personalRemoteAdmin("/credentials/revoke", { id: active[selected].id }, home);
        io.write("原桌面凭据已撤销，旧观察连接已关闭；此前接纳的工作仍继续，可用其他凭据或服务器核实原回执。\n");
      } else if (action === 5) {
        const diagnostic = await personalRemoteAdmin<{ identity: { binding: { origin: string; owner: string; profile: { directory: string } } } }>("/diagnostic", undefined, home);
        const binding = diagnostic.identity.binding;
        io.write(`当前绑定：${binding.origin} → ${binding.profile.directory}，拥有者 ${binding.owner}。旧凭据不会恢复。\n`);
        if (await choose(io, "确认当前绑定后重新配对", ["确认当前绑定", "返回"]) === 0) { await personalRemoteAdmin("/binding/confirm", {}, home); io.write("当前绑定已确认，可开启新配对。\n"); }
      } else {
        const result = await personalRemoteAdmin<{ identity: { confirmed: boolean }; unavailable?: string; pending?: { stage: string } }>("/diagnostic", undefined, home);
        io.write(`绑定${result.identity.confirmed ? "已确认" : "待确认"}；${result.unavailable ? `业务关闭：${result.unavailable}` : "认证入口可用"}；${result.pending ? `原维护阶段：${result.pending.stage}` : "没有未决维护"}。\n`);
      }
    } catch (error) { io.write(error instanceof PersonalError ? `${error.message}（${error.code}）\n` : "本机远程管理失败，请保留原状态并检查权限与磁盘；未自动重试。\n"); }
  }
}

export async function runPersonalRemoteCli(args: string[], directory: string): Promise<number> {
  if (args.length > 1 || args.length === 1 && args[0] !== "serve") throw new PersonalError("cli_arguments", "ruukoto remote 打开本机管理向导；ruukoto remote serve 前台托管固定远程入口。");
  if (!args.length) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new PersonalError("cli_terminal_required", "远程管理向导需要交互终端；固定服务使用 remote serve。");
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try { await personalRemoteMenu(directory, { question: prompt => readline.question(prompt), write: value => process.stdout.write(value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")) }); }
    finally { readline.close(); }
    return 0;
  }
  let signal!: () => void;
  const interrupted = new Promise<void>(resolve => { signal = resolve; });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const name of signals) process.on(name, signal);
  let remote: Awaited<ReturnType<typeof startPersonalRemote>> | undefined;
  try { remote = await startPersonalRemote(); await interrupted; return 0; }
  finally { try { await remote?.stop(); } finally { for (const name of signals) process.off(name, signal); } }
}
