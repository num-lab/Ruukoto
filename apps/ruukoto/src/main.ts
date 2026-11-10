import { runCli } from "@ruukoto/tui/cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
