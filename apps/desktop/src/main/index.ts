import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { CodeController, serializeFailure } from "./controller.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { adoptEnvironment, codeTargetConfig, DesktopError, selectEnvironment } from "./environment.ts";
import { handleRequest, ipcResult } from "./ipc.ts";
import { cspFor, externalUrl, isRendererReload } from "./security.ts";
import { PersonalController } from "./personal-controller.ts";
import { loadPersonalConfig, savePersonalConfig } from "./personal-config.ts";
import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";

declare const __RUUKOTO_REPOSITORY__: string;
let window: BrowserWindow | null = null;
let controller: CodeController | null = null;
let initialization: Promise<void> | null = null;
let environment: Promise<Awaited<ReturnType<typeof selectEnvironment>>> | null = null;
let personal: PersonalController | null = null;
let personalInitialization: Promise<void> | null = null;
let personalGeneration = 0;
let quitting = false;
let quitReady = false;
const subscribed = new Set<DesktopTarget>();
const lastState: Record<DesktopTarget, DesktopUpdate> = { code: { type: "state", state: "connecting" }, personal: { type: "state", state: "closed", detail: "尚未配置 Personal 连接" } };
function publishTarget(target: DesktopTarget, update: DesktopUpdate): void {
  if (update.type === "state") lastState[target] = update;
  if (subscribed.has(target) && window && !window.isDestroyed()) window.webContents.send("desktop:update", target, update);
}
const publish = (update: DesktopUpdate) => publishTarget("code", update);
function getEnvironment(): NonNullable<typeof environment> {
  environment ??= selectEnvironment(process.env).then(source => { adoptEnvironment(source.env); return source; }).catch(error => { environment = null; throw error; });
  return environment;
}
async function initializeController(): Promise<void> {
  const source = await getEnvironment();
  if (quitting) return;
  const config = codeTargetConfig(__RUUKOTO_REPOSITORY__, source);
  controller = new CodeController(config, publish, undefined, new PendingRequestStore(path.join(app.getPath("userData"), "pending", "code", createHash("sha256").update(config.controlDir).digest("hex"))));
}
function reconnectPersonal(replace = false): Promise<void> {
  if (quitting) return Promise.resolve();
  if (personalInitialization && !replace) return personalInitialization;
  const generation = ++personalGeneration;
  const previous = personalInitialization;
  const closing = personal?.close();
  personalInitialization = (async () => {
    try {
      await closing;
      await previous;
      if (quitting || generation !== personalGeneration) return;
      const config = loadPersonalConfig(app.getPath("userData"));
      if (!config) return;
      const source = await getEnvironment();
      if (quitting || generation !== personalGeneration) return;
      personal = new PersonalController(config, app.getPath("userData"), update => { if (generation === personalGeneration) publishTarget("personal", update); }, source.env);
      await personal.reconnect();
    } catch (error) { if (generation === personalGeneration && !quitting) publishTarget("personal", { type: "state", state: "failed", error: serializeFailure(error) }); }
  })().finally(() => { if (generation === personalGeneration) personalInitialization = null; });
  return personalInitialization;
}
function reconnect(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (!controller) {
      try { await initializeController(); }
      catch (error) { publish({ type: "state", state: "failed", error: serializeFailure(error) }); return; }
    }
    if (!quitting) await controller!.reconnect();
  })().finally(() => { initialization = null; });
  return initialization;
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}
function assertTrusted(event: Electron.IpcMainInvokeEvent): void {
  if (!trusted(event)) throw new DesktopError("ipc_sender", "桌面请求来源不可用；请重新打开应用。");
}
function openExternal(value: string): void {
  const url = externalUrl(value);
  if (url) void shell.openExternal(url).catch(() => { process.stderr.write("[ruukoto:desktop] 无法打开系统浏览器，请核对默认浏览器设置。\n"); });
}

async function createWindow(): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    const policy = cspFor(devUrl, process.env.RUUKOTO_DESKTOP_DEV_NONCE ?? "");
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${new URL(devUrl).origin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
    });
  }
  window = new BrowserWindow({ width: 1160, height: 780, minWidth: 760, minHeight: 500, title: "Ruukoto", titleBarStyle: "hiddenInset", vibrancy: "sidebar", webPreferences: { preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("will-navigate", (event, url) => {
    if (isRendererReload(url, devUrl)) return;
    event.preventDefault();
    openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  window.on("closed", () => { subscribed.clear(); window = null; });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}

ipcMain.on("desktop:subscribe", (event, target: unknown) => {
  if (!trusted(event) || (target !== "code" && target !== "personal")) return;
  subscribed.add(target);
  publishTarget(target, lastState[target]);
  if (target === "code" && (!controller || controller.status.state === "online")) void reconnect();
  if (target === "personal" && (!personal || personal.status.state === "online")) void reconnectPersonal();
});
ipcMain.handle("desktop:request", async (event, target, op, params) => {
  const checked = await ipcResult(() => assertTrusted(event));
  return checked.ok ? handleRequest(target, op, params, target === "personal" ? reconnectPersonal : reconnect, (op, params) => {
    if (!controller) throw new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent");
    return controller.dispatch(op, params);
  }, (op, params) => {
    if (!controller?.submissions) throw new DesktopError("connection_unavailable", "请等待连接恢复后再处理原输入。");
    return controller.submissions.local(op, params);
  }, async (op, params) => {
    if (op === "desktop_personal_config_read") return loadPersonalConfig(app.getPath("userData"));
    const config = savePersonalConfig(app.getPath("userData"), params);
    await reconnectPersonal(true);
    return config;
  }) : checked;
});
ipcMain.handle("desktop:pick-folder", event => ipcResult(async () => {
  assertTrusted(event);
  const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"], title: "选择工作区" });
  return result.canceled ? null : result.filePaths[0] ?? null;
}));
ipcMain.handle("desktop:reveal", (event, value: unknown) => ipcResult(() => {
  assertTrusted(event);
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new DesktopError("invalid_path", "请选择有效的本机绝对路径。");
  shell.showItemInFolder(value);
}));

app.on("before-quit", event => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  ++personalGeneration;
  controller?.close();
  void Promise.all([personal?.close(), personalInitialization, initialization]).catch(() => {
    process.stderr.write("[ruukoto:desktop] Personal 退出清理失败；请检查应用数据目录权限。\n");
  }).finally(() => { quitReady = true; app.quit(); });
});
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => { await createWindow(); void reconnectPersonal(); }).catch(() => { process.stderr.write("[ruukoto:desktop] 桌面窗口启动失败，请检查开发 nonce 或重新构建应用。\n"); app.quit(); });
