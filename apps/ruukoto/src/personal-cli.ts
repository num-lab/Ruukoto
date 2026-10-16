import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_PENDING_FILE, lockPersonalProfile } from "./personal-profile.ts";
import { personalDevDirectory, readPersonalConfig, savePersonalConfig } from "./personal-config.ts";
import { parsePersonalInput, personalControl, startPersonalServer, type PersonalInput, type PersonalInputStatus, type PersonalMessage, type PersonalStatus } from "./personal-control.ts";

export type PersonalCliIO = { question(prompt: string): Promise<string>; write(text: string): void };

export function personalChildEnv(directory: string, credential: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith("RUUKOTO_")) delete env[key];
  env[credential] = source[credential];
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
  let credential: string;
  try {
    credential = readPersonalConfig(profile).apiKeyEnv;
    if (!process.env[credential]) throw new PersonalError("model_credentials_missing", "请先设置模型凭据环境变量，再启动隔离后台。");
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

export async function personalMenu(directory: string, io: PersonalCliIO): Promise<void> {
  io.write(`个人 durable 隔离实例\n档案：${directory}\n当前仅提供主会话验证；权限、IM 与业务工具尚未接入。\n`);
  while (true) {
    const selected = await choose(io, "个人实例", ["配置模型（后台须停止）", "启动隔离后台", "查看状态", "发送消息", "查看最近消息", "核实上次提交", "停止隔离后台", "退出向导（后台继续运行）"]);
    if (selected === 7) return;
    try {
      if (selected === 0) await configure(io, directory);
      else if (selected === 1) { await launchPersonalServer(directory); io.write("隔离后台已启动。\n"); }
      else if (selected === 2) {
        const status = await personalControl<PersonalStatus>(directory, "GET", "/status");
        io.write(`后台在线；模型：${status.model}；未完成输入：${status.inputs}；活动任务：${status.tasks}。\n`);
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
      else {
        const action = await choose(io, "停止后台会暂停处理，未完成输入保留供下次恢复", ["返回", "停止隔离后台"]);
        if (action === 1) { await personalControl(directory, "POST", "/stop"); io.write("已请求停止，请等待后台释放档案；连接断开本身不证明已停止。\n"); }
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
