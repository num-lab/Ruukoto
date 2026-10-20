import type { Session } from "electron";

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export function cspFor(devServerUrl: string, nonce: string): string {
  const url = new URL(devServerUrl);
  if (url.protocol !== "http:" || !/^[A-Za-z0-9_-]{16,}$/.test(nonce)) throw new Error("开发页面需要 HTTP 地址与启动器生成的 nonce");
  const socket = new URL(url.origin);
  socket.protocol = "ws:";
  return `default-src 'self'; script-src 'self' ${url.origin} 'nonce-${nonce}'; style-src 'self' ${url.origin} 'nonce-${nonce}'; connect-src 'self' ${url.origin} ${socket.origin}; object-src 'none'; base-uri 'none'; frame-src http: https:; img-src 'self' data:; frame-ancestors 'none'`;
}

export function externalUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
}

export function isRendererOrigin(value: string, rendererUrl: string | undefined): boolean {
  if (!rendererUrl) return false;
  let target: URL, renderer: URL;
  try { target = new URL(value); renderer = new URL(rendererUrl); } catch { return false; }
  return (renderer.protocol === "http:" || renderer.protocol === "https:") && target.origin === renderer.origin;
}

export function browserFrameAllowed(value: string, rendererUrl: string | undefined): boolean {
  return value === "about:blank" || externalUrl(value) !== null && !isRendererOrigin(value, rendererUrl);
}

// 本地界面使用主进程通知与系统选择器，不需要网页设备或媒体权限。
export function denyBrowserPermissions(target: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler" | "setDevicePermissionHandler" | "setDisplayMediaRequestHandler">): void {
  target.setPermissionCheckHandler(() => false);
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setDevicePermissionHandler(() => false);
  target.setDisplayMediaRequestHandler((_request, callback) => callback(null));
}

export function isRendererReload(value: string, devServerUrl: string | undefined): boolean {
  return !!devServerUrl && value === new URL(devServerUrl).href;
}
