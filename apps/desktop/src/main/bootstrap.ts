import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { adoptEnvironment } from "./environment.ts";
import { assertElectronStartup } from "./startup.ts";

async function start(): Promise<void> {
  assertElectronStartup(app.isPackaged, process.execPath, app.getAppPath(), process.argv.slice(1), process.env);
  if (app.isPackaged) adoptEnvironment(process.env);
  else {
    app.setName("Ruukoto Development");
    const userData = path.join(app.getPath("appData"), "Ruukoto Development");
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    app.setPath("userData", userData);
  }
  if (!app.requestSingleInstanceLock()) { app.exit(1); return; }
  await import("./index.ts");
}
void start().catch(() => {
  process.stderr.write("[ruukoto:desktop] 桌面启动校验失败；请移除调试与开发覆盖参数，重新构建后打开应用。\n");
  app.exit(1);
});
