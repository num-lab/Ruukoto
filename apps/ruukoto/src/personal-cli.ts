import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_PENDING_FILE, lockPersonalProfile } from "./personal-profile.ts";
import { personalDevDirectory, readPersonalConfig, savePersonalConfig } from "./personal-config.ts";
import { parsePersonalInput, personalControl, startPersonalServer, type PersonalInput, type PersonalInputStatus, type PersonalMessage, type PersonalStatus } from "./personal-control.ts";
import { parsePersonalTelegram, readPersonalTelegram, savePersonalTelegram, telegramToken } from "./personal-telegram-config.ts";
import { personalTelegramApi, telegramOffset, telegramText } from "./personal-telegram-api.ts";
import type { PersonalHarness } from "./personal-harness.ts";
import { readPersonalServices, savePersonalServices } from "./personal-service-config.ts";
import { personalServiceConfig } from "./personal-services.ts";

export type PersonalCliIO = { question(prompt: string): Promise<string>; write(text: string): void };

export function personalChildEnv(directory: string, credential: string | readonly string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith("RUUKOTO_")) delete env[key];
  for (const name of typeof credential === "string" ? [credential] : credential) env[name] = source[name];
  env.RUUKOTO_PERSONAL_DIR = directory;
  return env;
}

export function preparePersonalInput(directory: string, input: string): PersonalInput {
  const request = parsePersonalInput({ requestId: randomUUID(), input });
  fs.writeFileSync(path.join(directory, `pending-${request.requestId}.json`), JSON.stringify(request) + "\n", { flag: "wx", mode: 0o600 });
  return request;
}

export function pendingPersonalInputs(directory: string): PersonalInput[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => PERSONAL_PENDING_FILE.test(name)).sort().map(name => {
    let saved: unknown;
    try {
      if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error("not a file");
      saved = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    } catch (error) { throw new PersonalError("pending_input_invalid", "待核实消息无法读取，请保留文件并检查；未重新提交。", { cause: error }); }
    const input = parsePersonalInput(saved);
    if (name !== `pending-${input.requestId}.json`) throw new PersonalError("pending_input_invalid", "待核实消息标识不一致，请保留文件并检查。");
    return input;
  });
}

export async function checkPersonalInput(directory: string, input: PersonalInput): Promise<PersonalInputStatus> {
  const result = await personalControl<PersonalInputStatus>(directory, "GET", `/input?requestId=${input.requestId}`);
  if (result.status !== "missing") fs.rmSync(path.join(directory, `pending-${input.requestId}.json`), { force: true });
  return result;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
export async function launchPersonalServer(directory: string): Promise<void> {
  const profile = lockPersonalProfile(directory);
  let log: number;
  let credential: string[];
  try {
    const modelCredential = readPersonalConfig(profile).apiKeyEnv;
    if (!process.env[modelCredential]) throw new PersonalError("model_credentials_missing", "请先设置模型凭据环境变量，再启动隔离后台。");
    const telegram = readPersonalTelegram(profile);
    const services = readPersonalServices(profile);
    if (services) personalServiceConfig({ ...services, useSudo: true });
    if (telegram?.enabled) telegramToken(telegram);
    credential = [modelCredential, ...(telegram?.enabled ? [telegram.tokenEnv] : [])];
    log = fs.openSync(path.join(directory, "backend.log"), "a", 0o600);
  } finally { profile.release(); }
  let failed = false;
  try {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./personal-entry.ts", import.meta.url)), "serve"], { env: personalChildEnv(directory, credential), detached: true, stdio: ["ignore", log, log] });
    child.on("error", () => { failed = true; });
    child.on("exit", () => { failed = true; });
    child.unref();
  } finally { fs.closeSync(log); }
  for (let attempt = 0; attempt < 60 && !failed; attempt++) {
    await delay(100);
    try { await personalControl<PersonalStatus>(directory, "GET", "/status"); return; } catch (error) {
      if (!(error instanceof PersonalError) || !["control_unavailable", "control_response_lost", "control_starting"].includes(error.code)) throw error;
    }
  }
  throw new PersonalError("control_start_unverified", "隔离后台启动尚未核实，请查看档案中的 backend.log 并查询状态；未接管或强制停止进程。");
}

async function choose(io: PersonalCliIO, title: string, options: string[]): Promise<number> {
  while (true) {
    io.write(`\n${title}\n${options.map((value, index) => `${index + 1}. ${value}`).join("\n")}\n`);
    const answer = (await io.question("请选择：")).trim();
    const selected = Number(answer) - 1;
    if (/^[1-9][0-9]*$/.test(answer) && selected < options.length) return selected;
    io.write("请输入列出的选项序号。\n");
  }
}

async function configure(io: PersonalCliIO, directory: string) {
  const profile = lockPersonalProfile(directory);
  try {
    io.write("配置只用于此隔离实例；凭据使用环境变量，不粘贴密钥。输入 /back 返回。\n");
    const selected = await choose(io, "模型接口", ["OpenAI Completions", "OpenAI Responses", "Anthropic Messages", "返回"]);
    if (selected === 3) return;
    const apis = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
    const values: string[] = [];
    for (const prompt of ["服务地址（完整 HTTPS URL）：", "模型名称：", "凭据环境变量名：", "上下文窗口（默认 128000）：", "最大输出（默认 4096）："]) {
      const value = (await io.question(prompt)).trim();
      if (value === "/back") return;
      values.push(value);
    }
    const config = { api: apis[selected], baseUrl: values[0], modelId: values[1], apiKeyEnv: values[2], contextWindow: Number(values[3] || "128000"), maxTokens: Number(values[4] || "4096") };
    savePersonalConfig(profile, config);
    io.write("模型配置已保存。请在启动后台的环境中设置所选凭据变量。\n");
  } finally { profile.release(); }
}

export async function configurePersonalTelegram(io: PersonalCliIO, directory: string) {
  const profile = lockPersonalProfile(directory);
  try {
    const action = await choose(io, "Telegram 文本入口", ["配对并启用专用测试 bot", "停用入口", "返回"]);
    if (action === 2) return;
    if (action === 1) {
      const current = readPersonalTelegram(profile);
      if (current) savePersonalTelegram(profile, { ...current, generation: randomUUID(), enabled: false });
      io.write("Telegram 入口已停用；旧目标的待发回复不转发，已开始的未知发送保留。\n");
      return;
    }
    io.write("先停止此 bot 的其他后台。本向导会确认专用测试 bot 的旧待收消息；边界及之前的委托不会执行，请在配对完成后重新发送。凭据使用环境变量，不粘贴 token。输入 /back 返回。\n");
    const apiBase = (await io.question("Telegram API 地址（默认 https://api.telegram.org）：")).trim();
    if (apiBase === "/back") return;
    const tokenEnv = (await io.question("Bot 凭据环境变量名：")).trim();
    if (tokenEnv === "/back") return;
    const draft = parsePersonalTelegram({ version: 1, enabled: true, generation: randomUUID(), apiBase: apiBase || "https://api.telegram.org", tokenEnv, tokenDigest: "0".repeat(64), botId: "1", ownerId: "1", boundary: 0 });
    const token = process.env[draft.tokenEnv];
    if (!token || !/^[1-9][0-9]*:[\w-]+$/.test(token)) throw new PersonalError("telegram_credentials_changed", "Bot 凭据环境变量未设置或格式无效，请设置后重新配对。");
    const api = personalTelegramApi(draft.apiBase, token);
    const signal = AbortSignal.timeout(180_000);
    const bot = await api.me(signal);
    if (bot.id !== token.split(":")[0]) throw new PersonalError("telegram_identity_invalid", "Bot 身份与凭据不符，请检查服务地址和凭据。");
    if (await choose(io, `接管 @${bot.username} 的专用测试入口并过滤旧积压`, ["返回", "确认接管并开始配对"]) === 0) return;
    const previous = await api.updates(signal, -1, 0);
    const ack = previous.length ? { offset: previous[previous.length - 1].update_id + 1, receivedAt: performance.now() } : undefined;
    const phrase = `配对 ${randomBytes(12).toString("hex")}`;
    const started = performance.now();
    await io.question(`请向 @${bot.username} 私聊发送“${phrase}”，3 分钟内完成后按回车：`);
    if (performance.now() - started >= 180_000) throw new PersonalError("telegram_pairing_expired", "配对已过期，请重新运行入口向导。");
    const updates = await api.updates(signal, telegramOffset(ack), 0);
    const receivedAt = performance.now();
    const candidates = updates.map(telegramText).filter((message): message is NonNullable<typeof message> => message?.text === phrase);
    if (!candidates.length) throw new PersonalError("telegram_pairing_missing", "尚未找到本轮私聊配对消息，请检查 bot 和发送方式后重新配对。");
    const selected = await choose(io, "选择刚才发送配对消息的拥有者", [...candidates.map(message => `${message.name}（Telegram 账号 ${message.ownerId}）`), "返回"]);
    if (selected === candidates.length) return;
    const boundary = updates[updates.length - 1].update_id;
    const offset = telegramOffset({ offset: boundary + 1, receivedAt });
    if (offset === undefined) throw new PersonalError("telegram_pairing_expired", "身份选择已过期，请重新配对；未用旧水位接管。");
    // 成功确认本批后才保存绑定；响应中的更新仍未确认，留给后台无 offset 重收。
    await api.updates(signal, offset, 0);
    savePersonalTelegram(profile, { ...draft, botId: bot.id, ownerId: candidates[selected].ownerId, boundary, tokenDigest: createHash("sha256").update(token).digest("hex") });
    io.write("Telegram 已配对。请启动隔离后台，再通过该私聊发送新消息；完整回答保存在个人会话中。\n");
  } finally { profile.release(); }
}

async function recoverInputs(io: PersonalCliIO, directory: string) {
  for (const input of pendingPersonalInputs(directory)) {
    io.write(`\n待核实消息：${input.input.slice(0, 160)}\n`);
    const result = await checkPersonalInput(directory, input);
    if (result.status !== "missing") { io.write("后台已受理原消息，请从最近消息查询结果。\n"); continue; }
    const action = await choose(io, "后台尚无此提交，原请求已保留", ["使用原请求继续提交", "保留并返回"]);
    if (action === 1) return false;
    await personalControl(directory, "POST", "/inputs", input);
    await checkPersonalInput(directory, input);
    io.write("原消息已受理。\n");
  }
  return true;
}

export async function configurePersonalServices(io: PersonalCliIO, directory: string): Promise<void> {
  const profile = lockPersonalProfile(directory);
  try {
    const current = readPersonalServices(profile);
    if (current) {
      io.write(`服务配置已固定：\nhelper：${current.helperPath}\n策略：${current.policyPath}\nsudo：${current.sudoPath}\n生产通过 sudo 调用。保留原配置供恢复；其他部署请使用新隔离档案。\n`);
      return;
    }
    if (process.platform !== "linux") throw new PersonalError("service_platform_unsupported", "服务能力需要 Linux；请在隔离 Linux 实例运行此向导。");
    io.write("先按部署说明安装受控 helper 与白名单。本向导只保存连接配置，不安装服务或修改 sudoers；启用后保留原路径供恢复。输入 /back 返回。\n");
    const values: string[] = [];
    for (const [label, fallback] of [["helper", "/usr/local/libexec/ruukoto/ruukoto-service"], ["策略", "/etc/ruukoto/services.json"], ["sudo", "/usr/bin/sudo"]]) {
      const value = (await io.question(`${label} 绝对路径（默认 ${fallback}）：`)).trim();
      if (value === "/back") return;
      values.push(value || fallback);
    }
    if (await choose(io, "启用只读服务检查与宿主审批；模型写工具仍待接入", ["返回", "保存并启用"]) === 0) return;
    await savePersonalServices(profile, { version: 1, helperPath: values[0], policyPath: values[1], sudoPath: values[2] });
    io.write("服务配置已保存。启动后台后查看装配状态；配置不代表 helper 可用或服务健康，实际检查由白名单与部署核实。\n");
  } finally { profile.release(); }
}

export async function personalMenu(directory: string, io: PersonalCliIO): Promise<void> {
  io.write(`个人 durable 隔离实例\n档案：${directory}\n提供主会话、可选 Telegram 文本入口及 Linux 服务检查；模型写工具继续实施。\n`);
  while (true) {
    const selected = await choose(io, "个人实例", ["配置模型（后台须停止）", "启动隔离后台", "查看状态", "发送消息", "查看最近消息", "核实上次提交", "停止隔离后台", "配置 Telegram（后台须停止）", "查看 Telegram 收发", "退出向导（后台继续运行）", "配置或查看服务（后台须停止）"]);
    if (selected === 9) return;
    try {
      if (selected === 0) await configure(io, directory);
      else if (selected === 1) { await launchPersonalServer(directory); io.write("隔离后台已启动。\n"); }
      else if (selected === 2) {
        const status = await personalControl<PersonalStatus>(directory, "GET", "/status");
        io.write(`后台在线；模型：${status.model}；未完成输入：${status.inputs}；活动任务：${status.tasks}；服务检查与宿主审批：${status.services ? "已装配" : "未装配"}。\n`);
      } else if (selected === 3) {
        if (!(await recoverInputs(io, directory))) continue;
        const message = await io.question("消息（输入 /back 返回）：");
        if (message === "/back") continue;
        await personalControl(directory, "GET", "/status");
        const input = preparePersonalInput(directory, message);
        await personalControl(directory, "POST", "/inputs", input);
        await checkPersonalInput(directory, input);
        io.write("消息已受理；可从最近消息查看回答，退出向导不取消处理。\n");
      } else if (selected === 4) {
        const messages = await personalControl<PersonalMessage[]>(directory, "GET", "/messages");
        if (!messages.length) io.write("尚无消息。\n");
        for (const message of messages) io.write(`\n${message.role === "user" ? "拥有者" : "助手"}${message.partial ? "（中断片段）" : ""}：${message.text}${message.truncated ? "\n（显示已截断，完整内容保留在 durable 历史中）" : ""}\n`);
      } else if (selected === 5) { if (await recoverInputs(io, directory)) io.write("没有尚待核实的提交。\n"); }
      else if (selected === 6) {
        const action = await choose(io, "停止后台会暂停处理，未完成输入保留供下次恢复", ["返回", "停止隔离后台"]);
        if (action === 1) { await personalControl(directory, "POST", "/stop"); io.write("已请求停止，请等待后台释放档案；连接断开本身不证明已停止。\n"); }
      } else if (selected === 7) await configurePersonalTelegram(io, directory);
      else if (selected === 10) await configurePersonalServices(io, directory);
      else {
        const state = await personalControl<Awaited<ReturnType<PersonalHarness["telegram"]["status"]>>>(directory, "GET", "/telegram");
        const labels = { waiting: "等待回答", pending: "等待发送", sending: "发送中，尚未核实", sent: "已发送", failed: "平台明确拒绝", effect_unknown: "发送效果未知，不自动重发", canceled: "已取消发送", unanswered: "未获得完整回答" };
        io.write(`Telegram ${!state.enabled ? "未启用" : state.online ? "接收在线" : state.receiving ? "等待连接恢复" : "接收已停止，请检查后台日志"}；已忽略非绑定私聊文本：${state.rejected} 条。最近最多 16 条收发：\n`);
        for (const item of state.recent) io.write(`${labels[item.delivery]}：${item.input}\n`);
      }
    } catch (error) {
      io.write(error instanceof PersonalError ? `${error.message}（${error.code}）\n` : "操作未能核实，请保留档案并检查磁盘与后台日志；未自动重试。\n");
    }
  }
}

export async function runPersonalCli(args: string[]): Promise<number> {
  const directory = process.env.RUUKOTO_PERSONAL_DIR ? path.resolve(process.env.RUUKOTO_PERSONAL_DIR) : personalDevDirectory(fileURLToPath(new URL("../../../", import.meta.url)));
  if (args.length > 1 || (args.length === 1 && args[0] !== "serve")) throw new PersonalError("cli_arguments", "用法：npm run personal:durable；前台托管使用 npm run personal:durable -- serve。");
  if (args[0] === "serve") {
    const server = await startPersonalServer(directory);
    const stop = () => void server.stop().catch(() => { process.stderr.write("[ruukoto:personal] 后台停止未核实，请检查进程与档案。\n"); process.exitCode = 1; });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
    try { const result = await server.closed; return result.reason === "failed" ? 1 : 0; }
    finally { for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop); await server.stop(); }
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new PersonalError("cli_terminal_required", "个人配置向导需要交互终端；前台后台使用 serve 子命令。");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const interrupted = new AbortController();
  readline.on("SIGINT", () => interrupted.abort());
  readline.on("close", () => interrupted.abort());
  try {
    await personalMenu(directory, { question: prompt => readline.question(prompt, { signal: interrupted.signal }), write: value => process.stdout.write(value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")) });
    return 0;
  } catch (error) { if (interrupted.signal.aborted) return 0; throw error; }
  finally { readline.close(); }
}
