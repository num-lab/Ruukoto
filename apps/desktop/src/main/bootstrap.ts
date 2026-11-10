import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { selectProfile } from "@ruukoto/core/profile.ts";
import { adoptEnvironment } from "./environment.ts";
import { assertElectronStartup } from "./startup.ts";

async function start(): Promise<void> {
  assertElectronStartup(app.isPackaged, process.execPath, app.getAppPath(), process.argv.slice(1), process.env);
  if (app.isPackaged) adoptEnvironment(process.env);
  else {
    const selection = selectProfile();
    const identity = createHash("sha256").update(JSON.stringify([selection.dataDir, selection.agentDir, selection.controlDir, selection.pendingDir])).digest("hex");
    app.setName("ruukoto Development");
    const userData = path.join(app.getPath("appData"), "ruukoto Development", identity);
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    app.setPath("userData", userData);
    app.setPath("sessionData", userData);
  }
  if (!app.requestSingleInstanceLock()) { app.exit(1); return; }
  await import("./index.ts");
}
void start().catch(() => {
  process.stderr.write("[ruukoto:desktop] Desktop startup validation failed; remove debug/dev override flags and rebuild before opening the app.\n");
  app.exit(1);
});
