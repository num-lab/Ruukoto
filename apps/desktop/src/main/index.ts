import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeController, serializeFailure } from "./controller.ts";
import { adoptEnvironment, codeTargetConfig, DesktopError, selectEnvironment } from "./environment.ts";
import { handleRequest, ipcResult } from "./ipc.ts";
import { cspFor, externalUrl, isRendererReload } from "./security.ts";
import type { DesktopUpdate } from "../shared/bridge.ts";

declare const __RUUKOTO_REPOSITORY__: string;
let window: BrowserWindow | null = null;
let controller: CodeController | null = null;
let initialization: Promise<void> | null = null;
let environment: Awaited<ReturnType<typeof selectEnvironment>> | null = null;
let subscribed = false;
let lastState: DesktopUpdate = { type: "state", state: "connecting" };
function publish(update: DesktopUpdate): void {
  if (update.type === "state") lastState = update;
  if (subscribed && window && !window.isDestroyed()) window.webContents.send("desktop:update", "code", update);
}
async function initializeController(): Promise<void> {
  environment ??= await selectEnvironment(process.env);
  adoptEnvironment(environment.env);
  controller = new CodeController(codeTargetConfig(__RUUKOTO_REPOSITORY__, environment), publish);
}
function reconnect(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (!controller) {
      try { await initializeController(); }
      catch (error) { publish({ type: "state", state: "failed", error: serializeFailure(error) }); return; }
    }
    await controller!.reconnect();
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
  window.on("closed", () => { subscribed = false; window = null; });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}

ipcMain.on("desktop:subscribe", (event, target) => {
  if (!trusted(event) || target !== "code") return;
  subscribed = true;
  publish(lastState);
  if (!controller || controller.status.state === "online") void reconnect();
});
ipcMain.handle("desktop:request", async (event, target, op, params) => {
  const checked = await ipcResult(() => assertTrusted(event));
  return checked.ok ? handleRequest(target, op, params, reconnect) : checked;
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

app.on("before-quit", () => controller?.close());
app.on("window-all-closed", () => app.quit());
app.whenReady().then(createWindow).catch(() => { process.stderr.write("[ruukoto:desktop] 桌面窗口启动失败，请检查开发 nonce 或重新构建应用。\n"); app.quit(); });
