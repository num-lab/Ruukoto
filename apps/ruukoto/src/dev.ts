import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runPersonalCli } from "./personal-cli.ts";
import { personalDevDirectory, personalDevelopmentEnv } from "./personal-config.ts";
import { PersonalError } from "./personal-error.ts";

// Note: 见 .agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md
const directory = personalDevDirectory(fileURLToPath(new URL("../../../", import.meta.url)));
const watched = process.env.RUUKOTO_PERSONAL_WATCH_CHILD === "1";
process.env = personalDevelopmentEnv(directory);
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--config")) throw new PersonalError("cli_arguments", "用法：npm run dev 托管开发后台；npm run dev -- --config 打开开发配置菜单。");
  if (args.length || watched) process.exitCode = await runPersonalCli(args.length ? [] : ["serve"], { directory, development: true });
  else {
    const child = spawn(process.execPath, ["--watch", "--import", "tsx", fileURLToPath(import.meta.url)], { env: { ...process.env, RUUKOTO_PERSONAL_WATCH_CHILD: "1" }, stdio: "inherit" });
    // watch 只处理 INT/TERM；统一 TERM 后等待退出，避免 HUP 留下监督器的子后台。
    const stop = () => { child.kill("SIGTERM"); };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, stop);
    try { const [status] = await once(child, "close"); process.exitCode = status ?? 1; }
    finally { for (const signal of signals) process.off(signal, stop); }
  }
} catch (error) {
  process.stderr.write(error instanceof PersonalError ? `[ruukoto:personal] ${error.code}：${error.message}（开发配置：npm run dev -- --config）\n` : "[ruukoto:personal] 开发入口失败，请保留档案并检查配置与后台日志。\n");
  process.exitCode = 1;
}
