import { runPersonalCli } from "./personal-cli.ts";
import { PersonalError } from "./personal-error.ts";

// Note: 见 .agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md
try { process.exitCode = await runPersonalCli(process.argv.slice(2)); } catch (error) {
  process.stderr.write(error instanceof PersonalError ? `[ruukoto:personal] ${error.code}：${error.message}\n` : "[ruukoto:personal] 个人入口失败，请保留档案并检查配置、磁盘与后台日志。\n");
  process.exitCode = 1;
}
