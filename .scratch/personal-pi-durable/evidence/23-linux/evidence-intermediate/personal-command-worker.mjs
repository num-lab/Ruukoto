// apps/ruukoto/src/personal-command-worker.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { constants } from "node:os";
import { spawn } from "node:child_process";

// apps/ruukoto/src/personal-error.ts
var PersonalError = class extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "PersonalError";
  }
  code;
};

// apps/ruukoto/src/personal-command-worker.ts
async function run() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4 * 1024 * 1024) throw new PersonalError("command_input_invalid", "\u547D\u4EE4\u8F93\u5165\u8D85\u9650\uFF0C\u672A\u542F\u52A8\u547D\u4EE4\uFF1B\u8BF7\u7F29\u5C0F\u8F93\u5165\u3002");
    chunks.push(bytes);
  }
  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (cause) {
    throw new PersonalError("command_input_invalid", "\u547D\u4EE4\u8F93\u5165\u4E0D\u662F\u6709\u6548 UTF-8 JSON\uFF0C\u672A\u542F\u52A8\u547D\u4EE4\uFF1B\u8BF7\u68C0\u67E5\u5BBF\u4E3B\u8F93\u5165\u3002", { cause });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PersonalError("command_input_invalid", "\u547D\u4EE4\u8F93\u5165\u65E0\u6548\uFF0C\u672A\u542F\u52A8\u547D\u4EE4\uFF1B\u8BF7\u68C0\u67E5\u5BBF\u4E3B\u8F93\u5165\u3002");
  const { command, workspace } = input;
  if (typeof command !== "string" || !command.trim() || command.includes("\0") || !workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new PersonalError("command_input_invalid", "\u547D\u4EE4\u6216\u76EE\u5F55\u8EAB\u4EFD\u65E0\u6548\uFF0C\u672A\u542F\u52A8\u547D\u4EE4\uFF1B\u8BF7\u68C0\u67E5\u5BBF\u4E3B\u8F93\u5165\u3002");
  const { path: directory, dev, ino } = workspace;
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.normalize(directory) !== directory || typeof dev !== "number" || !Number.isSafeInteger(dev) || dev < 0 || typeof ino !== "number" || !Number.isSafeInteger(ino) || ino < 0) throw new PersonalError("command_input_invalid", "\u76EE\u5F55\u8EAB\u4EFD\u65E0\u6548\uFF0C\u672A\u542F\u52A8\u547D\u4EE4\uFF1B\u8BF7\u68C0\u67E5\u5BBF\u4E3B\u8F93\u5165\u3002");
  try {
    const stat = fs.statSync(".");
    const target = fs.statSync(directory);
    if (fs.realpathSync(directory) !== directory || process.cwd() !== directory || !stat.isDirectory() || !target.isDirectory() || stat.dev !== dev || stat.ino !== ino || target.dev !== dev || target.ino !== ino) throw new PersonalError("command_workspace_changed", "\u547D\u4EE4\u76EE\u5F55\u8EAB\u4EFD\u5DF2\u53D8\u5316\uFF0C\u672A\u542F\u52A8\u547D\u4EE4\uFF1B\u8BF7\u4FDD\u7559\u539F\u5DE5\u4F5C\u5E76\u6838\u5B9E\u76EE\u5F55\u3002");
  } catch (cause) {
    if (cause instanceof PersonalError) throw cause;
    throw new PersonalError("command_workspace_changed", "\u547D\u4EE4\u76EE\u5F55\u8EAB\u4EFD\u65E0\u6CD5\u6838\u5B9E\uFF0C\u672A\u542F\u52A8\u547D\u4EE4\uFF1B\u8BF7\u4FDD\u7559\u539F\u5DE5\u4F5C\u5E76\u6838\u5B9E\u76EE\u5F55\u3002", { cause });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", (cause) => reject(new PersonalError("command_start_failed", "\u547D\u4EE4\u5165\u53E3\u65E0\u6CD5\u542F\u52A8\uFF1B\u8BF7\u4FDD\u7559\u5DE5\u4F5C\u5E76\u68C0\u67E5 Bash \u5B89\u88C5\u3002", { cause })));
    child.once("close", (code, signal) => resolve(signal ? 128 + constants.signals[signal] : code ?? 125));
  });
}
try {
  process.exitCode = await run();
} catch (error) {
  const failure = error instanceof PersonalError ? error : new PersonalError("command_worker_failed", "\u547D\u4EE4\u5DE5\u4F5C\u8FDB\u7A0B\u5F02\u5E38\uFF1B\u8BF7\u4FDD\u7559\u5DE5\u4F5C\u5E76\u6838\u5B9E\u539F\u6267\u884C\u4E0E\u6548\u679C\u3002", { cause: error });
  process.stderr.write(`[ruukoto:command] ${failure.code}: ${failure.message}
`);
  process.exitCode = 125;
}
