import { managePersonalQuestions } from "./personal-questions-cli.ts";
import { managePersonalBackground } from "./personal-background-cli.ts";
import { managePersonalPermissions } from "./personal-permissions-cli.ts";
import { managePersonalAppData } from "./personal-app-data-controls.ts";
import { configurePersonalSkills } from "./personal-skills-cli.ts";
import { managePersonalMemory, managePersonalHistory } from "./personal-memory-controls.ts";
import { configurePersonalQq } from "./personal-qq-cli.ts";
import { readPersonalQq, qqToken } from "./personal-qq-config.ts";
import { configurePersonalBrowser, managePersonalBrowser } from "./personal-browser-cli.ts";
import { configurePersonalTools, managePersonalTools } from "./personal-tools-cli.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_PENDING_FILE, lockPersonalProfile, personalDirectory } from "./personal-profile.ts";
import { readPersonalConfig, savePersonalConfig } from "./personal-config.ts";
import { parsePersonalInput, personalControl, startPersonalServer, type PersonalInput, type PersonalInputStatus, type PersonalMessage, type PersonalStatus } from "./personal-control.ts";
import { parsePersonalTelegram, readPersonalTelegram, savePersonalTelegram, telegramToken } from "./personal-telegram-config.ts";
import { personalTelegramApi, telegramOffset, telegramText } from "./personal-telegram-api.ts";
import type { TaskId } from "@earendil-works/pi-durable";
import type { PersonalHarness } from "./personal-harness.ts";
import { listPersonalDelegations, personalDelegationProgress } from "./personal-delegation.ts";
import { personalDelegationDescription, personalReportDelivery } from "./personal-work-controls.ts";
import type { personalReportResult } from "./personal-report.ts";
import { readPersonalServices, savePersonalServices } from "./personal-service-config.ts";
import { personalServiceConfig } from "./personal-services.ts";
import { personalInspectionDescription, type PersonalInspectionPage } from "./personal-inspection-controls.ts";
import { personalServiceDescription, type PersonalServicePage, type PersonalServiceDetail } from "./personal-service-controls.ts";
import { personalWorkDescription } from "./personal-work-controls.ts";
import type { listPersonalWorks, personalWorkResult, PersonalWorkSummary } from "./personal-work.ts";
import { readPersonalCommands, savePersonalCommands } from "./personal-command-config.ts";
import { tmpdir } from "node:os";
import { configurePersonalMcp, managePersonalMcp } from "./personal-mcp-cli.ts";
import { managePersonalSchedules } from "./personal-scheduler-cli.ts";

export type PersonalCliIO = { question(prompt: string): Promise<string>; write(text: string): void };

export function personalChildEnv(directory: string, credential: string | readonly string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith("RUUKOTO_")) delete env[key];
  for (const name of typeof credential === "string" ? [credential] : credential) env[name] = source[name];
  env.RUUKOTO_PERSONAL_DIR = directory;
  return env;
}

const pendingName = (input: PersonalInput) => `pending-${input.work === undefined ? "" : "work-"}${input.requestId}.json`;

export function preparePersonalInput(directory: string, input: string, work?: TaskId): PersonalInput {
  const request = parsePersonalInput({ requestId: randomUUID(), input, ...(work === undefined ? {} : { work }) });
  fs.writeFileSync(path.join(directory, pendingName(request)), JSON.stringify(request) + "\n", { flag: "wx", mode: 0o600 });
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
    if (name !== pendingName(input)) throw new PersonalError("pending_input_invalid", "待核实消息标识不一致，请保留文件并检查。");
    return input;
  });
}

export async function checkPersonalInput(directory: string, input: PersonalInput): Promise<PersonalInputStatus> {
  const result = await personalControl<PersonalInputStatus>(directory, "GET", `${input.work === undefined ? "/input" : "/work/notes"}?requestId=${input.requestId}${input.work === undefined ? "" : `&work=${input.work}`}`);
  if (result.status !== "missing") fs.rmSync(path.join(directory, pendingName(input)), { force: true });
  return result;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
export async function launchPersonalServer(directory: string): Promise<void> {
  const profile = lockPersonalProfile(directory);
  let log: number;
  let credential: string[];
  try {
    const modelCredential = readPersonalConfig(profile).apiKeyEnv;
    if (!process.env[modelCredential]) throw new PersonalError("model_credentials_missing", "请先设置模型凭据环境变量，再启动个人后台。");
    const telegram = readPersonalTelegram(profile);
    const qq = readPersonalQq(profile);
    const services = readPersonalServices(profile);
    readPersonalCommands(profile);
    if (services) personalServiceConfig({ ...services, useSudo: true });
    if (telegram?.enabled) telegramToken(telegram);
    if (qq?.enabled) qqToken(qq);
    credential = [modelCredential, ...(telegram?.enabled ? [telegram.tokenEnv] : []), ...(qq?.enabled ? [qq.tokenEnv] : [])];
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
  throw new PersonalError("control_start_unverified", "个人后台启动尚未核实，请查看档案中的 backend.log 并查询状态；未接管或强制停止进程。");
}

export async function choose(io: PersonalCliIO, title: string, options: string[]): Promise<number> {
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
    io.write("配置只用于此个人实例；凭据使用环境变量，不粘贴密钥。输入 /back 返回。\n");
    const selected = await choose(io, "模型接口", ["OpenAI Completions", "OpenAI Responses", "Anthropic Messages", "返回"]);
    if (selected === 3) return;
    const apis = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
    const values: string[] = [];
    for (const prompt of ["服务地址（完整 HTTPS URL）：", "模型名称：", "凭据环境变量名：", "上下文窗口（默认 128000）：", "最大输出（默认 4096）："]) {
      const value = (await io.question(prompt)).trim();
      if (value === "/back") return;
      values.push(value);
    }
    const imageInput = await choose(io, "此模型支持图片输入吗？", ["仅文字", "支持图片", "返回"]);
    if (imageInput === 2) return;
    const config = { imageInput: imageInput === 1, api: apis[selected], baseUrl: values[0], modelId: values[1], apiKeyEnv: values[2], contextWindow: Number(values[3] || "128000"), maxTokens: Number(values[4] || "4096") };
    await savePersonalConfig(profile, config);
    io.write("模型配置已保存。请在启动后台的环境中设置所选凭据变量。\n");
  } finally { profile.release(); }
}

export async function configurePersonalTelegram(io: PersonalCliIO, directory: string) {
  const profile = lockPersonalProfile(directory);
  try {
    const action = await choose(io, "Telegram 入口", ["配对并启用专用 bot", "停用入口", "返回"]);
    if (action === 2) return;
    if (action === 1) {
      const current = readPersonalTelegram(profile);
      if (current) savePersonalTelegram(profile, { ...current, generation: randomUUID(), enabled: false });
      io.write("Telegram 入口已停用；旧目标的待发回复不转发，已开始的未知发送保留。\n");
      return;
    }
    io.write("先停止此 bot 的其他后台。本向导会确认专用 bot 的旧待收消息；边界及之前的委托不会执行，请在配对完成后重新发送。凭据使用环境变量，不粘贴 token。输入 /back 返回。\n");
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
    if (await choose(io, `接管 @${bot.username} 的专用入口并过滤旧积压`, ["返回", "确认接管并开始配对"]) === 0) return;
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
    io.write("Telegram 已配对。请启动个人后台，再通过该私聊发送新消息；完整回答保存在个人会话中。\n");
  } finally { profile.release(); }
}

async function recoverInputs(io: PersonalCliIO, directory: string) {
  for (const input of pendingPersonalInputs(directory)) {
    io.write(`\n待核实${input.work === undefined ? "消息" : "原分析追加说明"}：${input.input.slice(0, 160)}\n`);
    const result = await checkPersonalInput(directory, input);
    if (result.status !== "missing") { io.write(input.work === undefined ? "后台已受理原消息，请从最近消息查询结果。\n" : "原分析已接纳说明，请从后台分析查询结果。\n"); continue; }
    const action = await choose(io, "后台尚无此提交，原请求已保留", ["使用原请求继续提交", "保留并返回"]);
    if (action === 1) return false;
    await personalControl(directory, "POST", input.work === undefined ? "/inputs" : "/work/notes", input);
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
      io.write(`服务配置已固定：\nhelper：${current.helperPath}\n策略：${current.policyPath}\nsudo：${current.sudoPath}\n生产通过 sudo 调用。保留原配置供恢复；其他部署请使用新个人档案。\n`);
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
    if (await choose(io, "启用服务检查与受控重启；写入沿原工作权限核实", ["返回", "保存并启用"]) === 0) return;
    await savePersonalServices(profile, { version: 1, helperPath: values[0], policyPath: values[1], sudoPath: values[2] });
    io.write("服务配置已保存。启动后台后查看装配状态；配置不代表 helper 可用或服务健康，实际检查由白名单与部署核实。\n");
  } finally { profile.release(); }
}

export async function configurePersonalCommands(io: PersonalCliIO, directory: string): Promise<void> {
  const profile = lockPersonalProfile(directory);
  try {
    const current = readPersonalCommands(profile);
    if (current) { io.write(`命令目录已固定：${current.workspace}\n供 Linux 子工作沿原权限使用；保留原目录、机器和临时目录供恢复，其他目录请使用新个人档案。\n`); return; }
    if (process.platform !== "linux") throw new PersonalError("command_platform_unsupported", "个人命令需要 Linux；请在隔离 Linux 实例运行此向导。");
    io.write("选择已存在、专供个人事务的目录；请求确认/自动审查仅在目录内读写且不联网；完全访问使用后台账户环境，可访问目录外资料和网络。不要选择后台档案、源码、凭据目录或其父目录。启用后初始目录不能更换；完全访问也须核实未知效果和原执行停止。输入 /back 返回。\n");
    const workspace = (await io.question("命令目录绝对路径：")).trim();
    if (workspace === "/back") return;
    if (!path.isAbsolute(workspace)) throw new PersonalError("command_config_invalid", "命令目录须为已存在的绝对路径，请重新选择专用目录。");
    let config;
    try {
      const real = fs.realpathSync(workspace);
      const stat = fs.statSync(real);
      config = { version: 1, workspace: real, identity: { dev: stat.dev, ino: stat.ino }, machineId: fs.readFileSync("/etc/machine-id", "utf8").trim(), tmpdir: fs.realpathSync(tmpdir()) };
    } catch (error) { throw new PersonalError("command_config_invalid", "命令目录或本机身份无法读取，请检查目录和 Linux 环境后重新配置。", { cause: error }); }
    if (await choose(io, `启用命令目录：${config.workspace}`, ["返回", "保存并启用"]) === 0) return;
    await savePersonalCommands(profile, config);
    io.write("命令配置已保存。启动后台后，子 Agent 可沿原工作权限执行命令；未知效果或停止未核实时保留占用，请核实原操作。\n");
  } finally { profile.release(); }
}

export async function managePersonalWorks(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof listPersonalWorks>>>(directory, "GET", `/works?offset=${offset}`);
    const options = [...page.items.map(personalWorkDescription), ...(page.nextOffset === undefined ? [] : ["下一页分析"]), "返回"];
    const selected = await choose(io, "后台分析（单项工作）", options);
    if (selected === options.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const ref = page.items[selected].ref;
    while (true) {
      const current = await personalControl<{ summary: PersonalWorkSummary; result: Awaited<ReturnType<typeof personalWorkResult>> }>(directory, "GET", `/work?work=${ref.taskId}`);
      io.write(`\n${personalWorkDescription(current.summary)}\n`);
      const action = await choose(io, "原分析操作", ["刷新状态", "读取原结果", "请求取消这项分析", "关闭此空闲身份", "返回分析列表", "追加说明"]);
      if (action === 4) break;
      if (action === 0) continue;
      if (action === 1) {
        let result = current.result;
        while (true) {
          if (result.notice) io.write(`\n${result.notice}\n`);
          io.write(result.text === undefined ? "原工作尚无成功完成的回答，请查询状态。\n" : `\n${result.partial ? "模型输出因长度限制截断，以下仅为已保存片段。\n" : ""}${result.text || "（无文本内容）"}\n`);
          if (result.nextOffset === undefined || await choose(io, "原结果还有后续内容", ["下一页结果", "返回原分析"]) === 1) break;
          result = (await personalControl<typeof current>(directory, "GET", `/work?work=${ref.taskId}&offset=${result.nextOffset}`)).result;
        }
      } else if (action === 2) {
        await personalControl(directory, "POST", `/work/cancel?work=${ref.taskId}`);
        io.write("原分析的取消请求已登记；请刷新核实停止。身份与历史保留，停止未核实前不能复用。\n");
      } else if (action === 5) {
        const content = await io.question("补充当前分析的说明（当前回答结束后处理，/back 返回）：");
        if (content === "/back") continue;
        const input = preparePersonalInput(directory, content, ref.taskId);
        await personalControl(directory, "POST", input.work === undefined ? "/inputs" : "/work/notes", input);
        await checkPersonalInput(directory, input);
        io.write("原分析已接纳说明；请刷新查询状态。权限保持原范围。\n");
      } else if (await choose(io, "关闭此身份后不能再委派，历史保留", ["返回", "关闭此空闲身份"]) === 1) {
        await personalControl(directory, "POST", `/work/close?work=${ref.taskId}`);
        io.write("原分析的空闲身份已关闭。\n");
      }
    }
  }
}

export async function managePersonalDelegations(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof listPersonalDelegations>>>(directory, "GET", `/delegations?offset=${offset}`);
    const choices = [...page.items.map(personalDelegationDescription), ...(page.more ? ["下一页委托"] : []), "返回"];
    const selected = await choose(io, "分析委托（可跨轮继续）", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length) { offset += 8; continue; }
    const ref = page.items[selected].ref;
    let memberOffset = 0;
    while (true) {
      const progress = await personalControl<Awaited<ReturnType<typeof personalDelegationProgress>>>(directory, "GET", `/delegation?delegation=${ref.entryId}&offset=${memberOffset}`);
      io.write(`\n${personalDelegationDescription(progress)}\n${progress.members.map(personalWorkDescription).join("\n")}\n取消覆盖所属分析、其固定服务检查及尚未开始的最终回报，不关闭身份、不涵盖独立宿主服务写操作；已开始的发送须按原效果核实。封组后不能追加；单项结果请从后台分析选择。\n`);
      const action = await choose(io, "原分析委托", ["刷新状态", "请求取消整项分析", "返回委托列表", "查看完整报告", ...(progress.nextOffset === undefined ? [] : ["下一页分析"])]);
      if (action === 2) break;
      if (action === 4) { memberOffset = progress.nextOffset!; continue; }
      if (action === 3) {
        let reportOffset = 0;
        while (true) {
          const report = await personalControl<Awaited<ReturnType<typeof personalReportResult>>>(directory, "GET", `/delegation/report?delegation=${ref.entryId}&offset=${reportOffset}`);
          io.write(`\n${personalReportDelivery(report.delivery)}\n${report.text ?? "尚无完整报告正文。"}\n`);
          if (report.nextOffset === undefined || await choose(io, "完整报告", ["下一页报告", "返回委托"]) === 1) break;
          reportOffset = report.nextOffset;
        }
      }
      if (action === 1) {
        await personalControl(directory, "POST", `/delegation/cancel?delegation=${ref.entryId}`);
        io.write("整项分析的取消请求已登记；刷新查询停止核实状态。身份和历史保留。\n");
      }
    }
  }
}

export async function managePersonalInspections(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<PersonalInspectionPage>(directory, "GET", `/inspections?offset=${offset}`);
    const choices = [...page.items.map(personalInspectionDescription), ...(page.nextOffset === undefined ? [] : ["下一页检查"]), "刷新列表", "返回"];
    const selected = await choose(io, "固定检查停止重核", choices);
    if (selected === choices.length - 1) return;
    if (selected === choices.length - 2) { offset = 0; continue; }
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const item = page.items[selected];
    io.write(`${personalInspectionDescription(item)}。只核实原固定检查退出，不确认服务写入效果，也不强制释放占用。\n`);
    if (!item.canRecheck || await choose(io, "请求原检查停止重核", ["返回列表", "登记停止重核"]) === 0) continue;
    await personalControl(directory, "POST", `/inspection/stop?inspection=${item.ref.taskId}&admission=${item.ref.admission}`);
    io.write("已登记原检查停止重核；登记不表示已停止。请刷新列表；原检查消失才表示停止已核实，仍在列表时请检查 helper 部署后再主动重核。\n");
    offset = 0;
  }
}

export async function managePersonalServices(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<PersonalServicePage>(directory, "GET", `/services?offset=${offset}`);
    const choices = [...page.items.map(item => item.unit), ...(page.nextOffset === undefined ? [] : ["下一页服务"]), "返回"];
    const selected = await choose(io, "服务审批、效果核实与停止重核", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const id = page.items[selected].ref.taskId;
    let evidenceOffset = 0;
    while (true) {
      const detail = await personalControl<PersonalServiceDetail>(directory, "GET", `/service?service=${id}&offset=${evidenceOffset}`);
      io.write(`\n${personalServiceDescription(detail.summary)}\n核实说明：${detail.evidence}\n未知效果须效果和停止均核实后才释放占用；不会重新执行 restart。\n`);
      const actions = ["刷新状态", ...(detail.summary.canDecide ? ["批准本次", "拒绝"] : []), ...(detail.summary.canResolve ? ["确认已生效", "确认未生效"] : []), ...(detail.summary.canRecheck ? ["登记原操作停止重核"] : []), ...(detail.nextOffset === undefined ? [] : ["下一页核实说明"]), "返回服务列表"];
      const action = actions[await choose(io, "原服务操作", actions)];
      if (action === "返回服务列表") break;
      if (action === "下一页核实说明") { evidenceOffset = detail.nextOffset!; continue; }
      evidenceOffset = 0;
      if (action === "批准本次" || action === "拒绝") {
        await personalControl(directory, "POST", `/service/decide?service=${id}`, { decision: action === "批准本次" ? "approved" : "rejected" });
        io.write("原服务决定已保存，批准不表示成功；请刷新查询。应答丢失先核实原状态。\n");
      } else if (action === "登记原操作停止重核") {
        await personalControl(directory, "POST", `/service/stop?service=${id}`);
        io.write("已登记原写操作停止重核；登记不表示已停止，也不确认写入效果。请刷新原状态；未核实则检查 helper 后主动重核。\n");
      } else if (action === "确认已生效" || action === "确认未生效") {
        const evidence = await io.question("独立核实后的证据说明（最多 8192 字符，不填凭据；/back 返回）：");
        if (evidence === "/back") continue;
        await personalControl(directory, "POST", `/service/resolve?service=${id}`, { effect: action === "确认已生效" ? "applied" : "not_applied", evidence });
        io.write("原效果核实及证据已保存，不可覆盖。若失去应答，请刷新原状态，不要重复提交。\n");
      }
    }
    offset = 0;
  }
}

export async function managePersonalCommands(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<NonNullable<PersonalHarness["commands"]>["list"]>>>(directory, "GET", `/commands?offset=${offset}`);
    const choices = [...page.items.map(item => item.command), ...(page.nextOffset === undefined ? [] : ["下一页命令"]), "返回"];
    const selected = await choose(io, "原命令与核实", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const id = page.items[selected].ref.taskId;
    let stream: "stdout" | "stderr" = "stdout", outputOffset = 0;
    while (true) {
      const detail = await personalControl<Awaited<ReturnType<NonNullable<PersonalHarness["commands"]>["detail"]>>>(directory, "GET", `/command?command=${id}&stream=${stream}&offset=${outputOffset}`);
      io.write(`\n原命令：${detail.command}\n结果：${detail.result?.effect ?? "尚未返回"}；退出码：${detail.result?.exitCode ?? "未知"}；停止：${detail.stopped ? "已核实" : "未核实"}。运行返回不代表业务成功。\n${detail.resolution ? `效果核实：${detail.resolution.effect}；${detail.resolution.evidence}\n` : ""}${detail.outputError ? `原输出无法核实（${detail.outputError}），保留现场。\n` : ""}`);
      if (detail.output) io.write(`${stream}${detail.output.complete ? "" : "（只捕获片段）"}，${detail.output.bytes} 字节。UTF-8 预览（跨页字符可能不完整）：\n${Buffer.from(detail.output.data, "base64").toString("utf8")}\n原字节 base64：\n${detail.output.data}\n`);
      const actions = ["刷新状态", "切换输出流", ...(detail.output?.nextOffset === undefined ? [] : ["下一页输出"]), ...(detail.canResolve ? ["确认已生效", "确认未生效"] : []), ...(detail.canRecheck ? ["登记原命令停止重核"] : []), "返回命令列表"];
      const action = actions[await choose(io, "原命令", actions)];
      if (action === "返回命令列表") break;
      if (action === "下一页输出") { outputOffset = detail.output!.nextOffset!; continue; }
      outputOffset = 0;
      if (action === "切换输出流") stream = stream === "stdout" ? "stderr" : "stdout";
      else if (action === "登记原命令停止重核") { await personalControl(directory, "POST", `/command/stop?command=${id}`); io.write("已登记原停止重核，登记不表示已停止；请刷新查询。\n"); }
      else if (action === "确认已生效" || action === "确认未生效") {
        const evidence = await io.question("独立核实后的证据说明（最多 8192 字符，不填凭据；/back 返回）：");
        if (evidence === "/back") continue;
        await personalControl(directory, "POST", `/command/resolve?command=${id}`, { effect: action === "确认已生效" ? "applied" : "not_applied", evidence });
        io.write("原效果说明已保存，不可覆盖；停止也核实后才解除暂停。应答丢失请刷新原记录，勿重送。\n");
      }
    }
    offset = 0;
  }
}

export async function personalMenu(directory: string, io: PersonalCliIO, launch?: () => Promise<void>): Promise<void> {
  io.write(`个人 Agent${launch ? " 开发实例" : ""}\n档案：${directory}\n通过聊天、后台工作、审批核实、权限和配置菜单管理此实例；IM 可直接发送 /帮助。\n`);
  while (true) {
    const actions = ["配置模型（后台须停止）", "启动个人后台", "查看状态", "发送消息", "查看最近消息", "核实上次提交", "停止个人后台", "配置 Telegram（后台须停止）", "查看 Telegram 收发", "退出向导（后台继续运行）", "配置或查看服务（后台须停止）", "管理后台分析", "管理分析委托", "管理检查停止重核", "管理服务审批与核实", "配置或查看命令目录（后台须停止）", "管理命令效果与停止核实", "配置或查看 MCP（后台须停止）", "管理 MCP 审批、原响应与效果", "配置资料与网络工具（后台须停止）", "管理工具审批、资料授权与产物", "配置浏览器（后台须停止）", "管理浏览器、截图与网页效果", "配置 QQ（后台须停止）", "查看 QQ 收发", "管理定时计划与运行", "配置或查看技能（后台须停止）", "管理长期记忆", "检索历史原文", "管理应用数据审批与回执", "管理默认模式与长期授权", "问题与回答", "管理会话后台与日志"];
    const groups = [
      { title: "聊天与消息", actions: [3, 4, 5, 31] },
      { title: "后台工作与定时计划", actions: [11, 12, 25, 32] },
      { title: "审批、效果与停止核实", actions: [13, 14, 16, 18, 20, 22, 29] },
      { title: "权限、授权与个人资料", actions: [30, 20, 27, 28] },
      { title: "配置能力（后台须停止）", actions: [0, 7, 23, 10, 15, 17, 19, 21, 26] },
      { title: "实例状态与启停", actions: [2, 1, 6, 8, 24] },
    ];
    const group = await choose(io, "个人实例", [...groups.map(group => group.title), launch ? "退出向导（停止本次开发后台）" : actions[9]]);
    if (group === groups.length) return;
    const current = groups[group];
    const action = await choose(io, current.title, [...current.actions.map(index => actions[index]), "返回"]);
    if (action === current.actions.length) continue;
    const selected = current.actions[action];
    if (selected === 9) return;
    try {
      if (selected === 0) await configure(io, directory);
      else if (selected === 1) { if (launch) await launch(); else await launchPersonalServer(directory); io.write("个人后台已启动。\n"); }
      else if (selected === 2) {
        const status = await personalControl<PersonalStatus>(directory, "GET", "/status");
        io.write(`后台在线；模型：${status.model}；未完成输入：${status.inputs}；活动任务：${status.tasks}；服务检查与宿主审批：${status.services ? "已装配" : "未装配"}。\n`);
        if (status.capabilities) io.write(`${Object.entries(status.capabilities).map(([name, enabled]) => `${({ commands: "命令", mcp: "MCP", tools: "资料与网络", browser: "浏览器", telegram: "Telegram", qq: "QQ" } as Record<string, string>)[name]}：${enabled ? "已配置" : "未配置"}`).join("；")}。装配与配置不证明外部服务可用。\n`);
      } else if (selected === 3) {
        if (!(await recoverInputs(io, directory))) continue;
        const message = await io.question("消息（输入 /back 返回）：");
        if (message === "/back") continue;
        await personalControl(directory, "GET", "/status");
        const input = preparePersonalInput(directory, message);
        await personalControl(directory, "POST", input.work === undefined ? "/inputs" : "/work/notes", input);
        await checkPersonalInput(directory, input);
        io.write("消息已受理；可从最近消息查看回答，退出向导不取消处理。\n");
      } else if (selected === 4) {
        const messages = await personalControl<PersonalMessage[]>(directory, "GET", "/messages");
        if (!messages.length) io.write("尚无消息。\n");
        for (const message of messages) io.write(`\n${message.role === "user" ? "拥有者" : "助手"}${message.partial ? "（中断片段）" : ""}：${message.text}${message.truncated ? "\n（显示已截断，完整内容保留在 durable 历史中）" : ""}\n`);
      } else if (selected === 5) { if (await recoverInputs(io, directory)) io.write("没有尚待核实的提交。\n"); }
      else if (selected === 6) {
        const action = await choose(io, "停止后台会暂停处理，未完成输入保留供下次恢复", ["返回", "停止个人后台"]);
        if (action === 1) { await personalControl(directory, "POST", "/stop"); io.write("已请求停止，请等待后台释放档案；连接断开本身不证明已停止。\n"); }
      } else if (selected === 7) await configurePersonalTelegram(io, directory);
      else if (selected === 10) await configurePersonalServices(io, directory);
      else if (selected === 11) await managePersonalWorks(io, directory);
      else if (selected === 12) await managePersonalDelegations(io, directory);
      else if (selected === 13) await managePersonalInspections(io, directory);
      else if (selected === 14) await managePersonalServices(io, directory);
      else if (selected === 15) await configurePersonalCommands(io, directory);
      else if (selected === 16) await managePersonalCommands(io, directory);
      else if (selected === 17) await configurePersonalMcp(io, directory);
      else if (selected === 18) await managePersonalMcp(io, directory);
      else if (selected === 19) await configurePersonalTools(io, directory);
      else if (selected === 20) await managePersonalTools(io, directory);
      else if (selected === 21) await configurePersonalBrowser(io, directory);
      else if (selected === 22) await managePersonalBrowser(io, directory);
      else if (selected === 23) await configurePersonalQq(io, directory);
      else if (selected === 25) await managePersonalSchedules(io, directory);
      else if (selected === 26) await configurePersonalSkills(io, directory);
      else if (selected === 27) await managePersonalMemory(io, directory);
      else if (selected === 29) await managePersonalAppData(io, directory);
      else if (selected === 31) await managePersonalQuestions(io, directory);
      else if (selected === 30) await managePersonalPermissions(io, directory);
      else if (selected === 32) await managePersonalBackground(io, directory);
      else if (selected === 28) await managePersonalHistory(io, directory);
      else {
        const state = await personalControl<Awaited<ReturnType<PersonalHarness["telegram"]["status"]>>>(directory, "GET", selected === 24 ? "/qq" : "/telegram");
        const labels = { waiting: "等待回答", pending: "等待发送", sending: "发送中，尚未核实", sent: "已发送", failed: "平台明确拒绝", effect_unknown: "发送效果未知，不自动重发", canceled: "已取消发送", unanswered: "未获得完整回答" };
        io.write(`${selected === 24 ? "QQ" : "Telegram"} ${!state.enabled ? "未启用" : state.online ? "接收在线" : state.receiving ? "等待连接恢复" : "接收已停止，请检查后台日志"}；两平台累计忽略无效收件：${state.rejected} 条。最近最多 16 条收发：\n`);
        if (selected === 24 && state.gap) io.write("检测到接收连接缺口；该期间消息没有投递保证，请核实未受理消息后重新发送。\n");
        for (const item of state.recent) io.write(`${labels[item.delivery]}：${item.input}\n`);
      }
    } catch (error) {
      io.write(error instanceof PersonalError ? `${error.message}（${error.code}）\n` : "操作未能核实，请保留档案并检查磁盘与后台日志；未自动重试。\n");
    }
  }
}

export async function runPersonalCli(args: string[], options: { directory?: string; development?: boolean } = {}): Promise<number> {
  const directory = options.directory ?? personalDirectory();
  if (args.length > 1 || (args.length === 1 && args[0] !== "serve")) throw new PersonalError("cli_arguments", "用法：ruukoto 打开引导菜单；ruukoto serve 前台托管。旧个人命令已退出，请保留旧资料并使用新档案。");
  if (!args.length && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new PersonalError("cli_terminal_required", "个人配置向导需要交互终端；前台后台使用 serve 子命令。");
  const interrupted = new AbortController();
  const aborted = new Promise<undefined>(resolve => interrupted.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  const stop = () => interrupted.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  let readline: ReturnType<typeof createInterface> | undefined;
  const launch = async () => {
    server = await startPersonalServer(directory, { development: options.development });
    interrupted.signal.throwIfAborted();
  };
  try {
    if (args[0] === "serve") {
      await launch();
      const result = await Promise.race([server!.closed, aborted]);
      return result?.reason === "failed" ? 1 : 0;
    }
    readline = createInterface({ input: process.stdin, output: process.stdout });
    readline.on("SIGINT", stop);
    readline.on("close", stop);
    await personalMenu(directory, { question: prompt => readline!.question(prompt, { signal: interrupted.signal }), write: value => process.stdout.write(value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")) }, options.development ? launch : undefined);
    return 0;
  } catch (error) { if (interrupted.signal.aborted) return 0; throw error; }
  finally {
    readline?.close();
    try { await server?.stop(); }
    finally { for (const signal of signals) process.off(signal, stop); }
  }
}
