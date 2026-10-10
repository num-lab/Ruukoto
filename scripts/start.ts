import { runCli } from "@ruukoto/tui/cli.ts";

// 保留根 npm start 的环境身份选择；产品 bin 仍各自固定身份。
const { product } = process.env.RUUKOTO_PRODUCT === "ruukoto-code"
  ? await import("../apps/ruukoto-code/src/product.ts")
  : await import("../apps/ruukoto/src/product.ts");
process.exitCode = await runCli(process.argv.slice(2), product);
