/** 单次命令入口；权限、效果回执与整个执行单元的停止证明由宿主持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-command-worker.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { constants } from "node:os";
import { spawn } from "node:child_process";
import { PersonalError } from "./personal-error.ts";

function verifyWorkspace(directory: string, dev: number, ino: number): void {
  const current = fs.statSync(".");
  const target = fs.statSync(directory);
  if (fs.realpathSync(directory) !== directory || process.cwd() !== directory || !current.isDirectory() || !target.isDirectory() || current.dev !== dev || current.ino !== ino || target.dev !== dev || target.ino !== ino) throw new PersonalError("command_workspace_changed", "命令目录身份已变化，未启动命令；请保留原工作并核实目录。");
}

async function run(): Promise<number> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4 * 1024 * 1024) throw new PersonalError("command_input_invalid", "命令输入超限，未启动命令；请缩小输入。");
    chunks.push(bytes);
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (cause) {
    throw new PersonalError("command_input_invalid", "命令输入不是有效 UTF-8 JSON，未启动命令；请检查宿主输入。", { cause });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PersonalError("command_input_invalid", "命令输入无效，未启动命令；请检查宿主输入。");
  const { command, workspace } = input as Record<string, unknown>;
  if (typeof command !== "string" || !command.trim() || command.includes("\0") || !workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new PersonalError("command_input_invalid", "命令或目录身份无效，未启动命令；请检查宿主输入。");
  const { path: directory, dev, ino } = workspace as Record<string, unknown>;
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.normalize(directory) !== directory || typeof dev !== "number" || !Number.isSafeInteger(dev) || dev < 0 || typeof ino !== "number" || !Number.isSafeInteger(ino) || ino < 0) throw new PersonalError("command_input_invalid", "目录身份无效，未启动命令；请检查宿主输入。");
  try {
    verifyWorkspace(directory, dev, ino);
  } catch (cause) {
    if (cause instanceof PersonalError) throw cause;
    throw new PersonalError("command_workspace_changed", "命令目录身份无法核实，未启动命令；请保留原工作并核实目录。", { cause });
  }
  // 继承已核实的当前目录，不在核对后按路径重新打开可能被替换的目录。
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", cause => reject(new PersonalError("command_start_failed", "命令入口无法启动；请保留工作并检查 Bash 安装。", { cause })));
    child.once("close", (code, signal) => resolve(signal ? 128 + constants.signals[signal] : code ?? 125));
  });
}

try {
  process.exitCode = await run();
} catch (error) {
  const failure = error instanceof PersonalError ? error : new PersonalError("command_worker_failed", "命令工作进程异常；请保留工作并核实原执行与效果。", { cause: error });
  process.stderr.write(`[ruukoto:command] ${failure.code}: ${failure.message}\n`);
  process.exitCode = 125;
}
