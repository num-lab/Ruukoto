import { app, BrowserWindow, Notification, dialog, ipcMain, session, shell } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopError } from "./environment.ts";
import { ipcResult } from "./ipc.ts";
import { browserFrameAllowed, cspFor, denyBrowserPermissions, externalUrl, isRendererReload } from "./security.ts";
import { DesktopHost } from "./host.ts";
import type { DesktopNotice } from "./notifications.ts";

declare const __RUUKOTO_REPOSITORY__: string;
let window: BrowserWindow | null = null;
let quitting = false;
let quitReady = false;
const notifications = new Set<Notification>();
function showNotice(notice: DesktopNotice): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: notice.title, body: notice.body });
  notifications.add(notification);
  notification.on("close", () => notifications.delete(notification));
  notification.on("failed", () => { notifications.delete(notification); process.stderr.write("[ruukoto:desktop] 系统通知未送达；请检查系统通知设置。\n"); });
  notification.on("click", () => {
    notifications.delete(notification);
    window?.show();
    window?.focus();
    host.navigate(notice);
  });
  notification.show();
}
const host = new DesktopHost(__RUUKOTO_REPOSITORY__, app.getPath("userData"), {
  publish: (target, update) => { if (window && !window.isDestroyed()) window.webContents.send("desktop:update", target, update); },
  focused: () => !!window?.isFocused(),
  notice: showNotice,
  badge: count => {
    try { app.dock?.setBadge(count ? String(count) : ""); }
    catch { process.stderr.write("[ruukoto:desktop] Dock 角标更新失败；请在应用中查看待审批。\n"); }
  },
});
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
  denyBrowserPermissions(session.defaultSession);
  session.defaultSession.on("will-download", event => event.preventDefault());
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: details.resourceType === "subFrame" && !browserFrameAllowed(details.url, devUrl) });
  });
  if (devUrl) {
    const policy = cspFor(devUrl, process.env.RUUKOTO_DESKTOP_DEV_NONCE ?? "");
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${new URL(devUrl).origin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
    });
  }
  window = new BrowserWindow({ width: 1160, height: 780, minWidth: 760, minHeight: 500, title: "Ruukoto", titleBarStyle: "hiddenInset", vibrancy: "sidebar", webPreferences: { preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } });
  const contents = window.webContents;
  contents.on("will-frame-navigate", event => {
    if (!event.isMainFrame && !browserFrameAllowed(event.url, devUrl) || event.isMainFrame && event.initiator && event.initiator !== contents.mainFrame) event.preventDefault();
  });
  contents.on("will-redirect", event => {
    if (event.isMainFrame ? !isRendererReload(event.url, devUrl) : !browserFrameAllowed(event.url, devUrl)) event.preventDefault();
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (event.initiator && event.initiator !== contents.mainFrame) { event.preventDefault(); return; }
    if (isRendererReload(url, devUrl)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.setWindowOpenHandler(({ url, referrer }) => { if (referrer.url === contents.getURL()) openExternal(url); return { action: "deny" }; });
  window.on("closed", () => { window = null; });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}

ipcMain.on("desktop:subscribe", (event, target: unknown) => {
  if (!trusted(event) || (target !== "code" && target !== "personal")) return;
  host.subscribe(target);
});
ipcMain.handle("desktop:request", async (event, target, op, params) => {
  const checked = await ipcResult(() => assertTrusted(event));
  return checked.ok ? host.request(target, op, params) : checked;
});
ipcMain.handle("desktop:pick-attachments", (event, sessionId: unknown) => ipcResult(async () => {
  assertTrusted(event);
  return host.pickAttachments(sessionId, async () => {
    const selection = await dialog.showOpenDialog(window!, { properties: ["openFile", "multiSelections"], title: "选择附件" });
    return selection.canceled ? [] : selection.filePaths;
  });
}));
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
  void host.close().catch(() => {
    process.stderr.write("[ruukoto:desktop] Personal 退出清理失败；请检查应用数据目录权限。\n");
  }).finally(() => { quitReady = true; app.quit(); });
});
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => { await createWindow(); void host.reconnectPersonal(); }).catch(() => { process.stderr.write("[ruukoto:desktop] 桌面窗口启动失败，请检查开发 nonce 或重新构建应用。\n"); app.quit(); });
