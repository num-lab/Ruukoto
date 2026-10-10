import { runCli } from "@ruukoto/tui/cli.ts";
import { product } from "./product.ts";

process.exitCode = await runCli(process.argv.slice(2), product);
