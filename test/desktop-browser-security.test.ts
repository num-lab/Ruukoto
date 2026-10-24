import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import type { Session, WebContents, PermissionCheckHandlerHandlerDetails } from "electron";
import { browserFrameAllowed, cspFor, denyBrowserPermissions, externalUrl, isRendererOrigin } from "../apps/desktop/src/main/security.ts";

test("内置网页仅接受无凭据 HTTP(S) 与默认空页，整个开发界面来源均不能嵌入", () => {
  const renderer = "http://localhost:5173/";
  for (const address of ["about:blank", "https://example.com/path", "http://127.0.0.1:8765/", "http://localhost:5174/"]) assert.equal(browserFrameAllowed(address, renderer), true, address);
  for (const address of ["", "relative", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,content", "blob:https://example.com/id", "about:srcdoc", "https://name:password@example.com/", "http://localhost:5173/", "http://localhost:5173/other?query#hash"]) assert.equal(browserFrameAllowed(address, renderer), false, address);
  assert.equal(isRendererOrigin("http://localhost:5173/other", renderer), true);
  assert.equal(isRendererOrigin("http://localhost:5173.evil/", renderer), false);
  assert.equal(isRendererOrigin("https://localhost:5173/", renderer), false);
  assert.equal(isRendererOrigin("https://example.com/", "file:///renderer/index.html"), false);
  assert.equal(isRendererOrigin("file:///renderer/other.html", "file:///renderer/index.html"), false);
  assert.equal(isRendererOrigin("invalid", renderer), false);
  assert.equal(isRendererOrigin("https://example.com/", undefined), false);
  assert.equal(browserFrameAllowed("https://example.com/", undefined), true);
  assert.equal(externalUrl("https://name:password@example.com/"), null);
});

test("开发 CSP 保留 nonce 与精确连接来源，样式放行内联以容纳 xterm 运行时注入", () => {
  const policy = cspFor("http://localhost:5173/path", "nonce_1234567890abcd");
  assert.match(policy, /script-src 'self' http:\/\/localhost:5173 'nonce-nonce_1234567890abcd'/);
  assert.match(policy, /style-src 'self' http:\/\/localhost:5173 'nonce-nonce_1234567890abcd' 'unsafe-inline'/);
  assert.match(policy, /connect-src 'self' http:\/\/localhost:5173 ws:\/\/localhost:5173;/);
  assert.match(policy, /frame-src http: https:;/);
  assert.match(policy, /img-src \* data: blob: file:;/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.ok(!policy.includes("unsafe-eval"));
});

test("网页权限检查、请求、设备与屏幕捕获均拒绝，不依赖 Electron 默认授权", () => {
  const handlers: { check?: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>; request?: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>; device?: NonNullable<Parameters<Session["setDevicePermissionHandler"]>[0]>; display?: NonNullable<Parameters<Session["setDisplayMediaRequestHandler"]>[0]> } = {};
  denyBrowserPermissions({ setPermissionCheckHandler: handler => { handlers.check = handler ?? undefined; }, setPermissionRequestHandler: handler => { handlers.request = handler ?? undefined; }, setDevicePermissionHandler: handler => { handlers.device = handler ?? undefined; }, setDisplayMediaRequestHandler: handler => { handlers.display = handler ?? undefined; } });
  assert.ok(handlers.check); assert.ok(handlers.request); assert.ok(handlers.device); assert.ok(handlers.display);
  // 第三方 SDK 句柄边界：处理器不读取此对象，夹具只承载原生回调的参数。
  const contents = {} as WebContents;
  const details: PermissionCheckHandlerHandlerDetails = { isMainFrame: false, embeddingOrigin: "file://", requestingUrl: "https://example.com/" };
  for (const permission of ["media", "notifications", "clipboard-read", "openExternal", "fileSystem", "geolocation", "usb", "display-capture"] as const) {
    assert.equal(handlers.check(contents, permission, "https://example.com", details), false);
    let granted = true;
    handlers.request(contents, permission, value => { granted = value; }, { requestingUrl: "https://example.com/", isMainFrame: false });
    assert.equal(granted, false);
  }
  assert.equal(handlers.device({ deviceType: "serial", origin: "https://example.com", device: { portId: "fixture-port", portName: "Fixture" } }), false);
  let streams: unknown = "not-called";
  handlers.display({ frame: null, securityOrigin: "https://example.com", videoRequested: true, audioRequested: false, userGesture: true }, value => { streams = value; });
  assert.equal(streams, null);
});

test("主进程同时封锁子 frame 导航与重定向，并保留主 frame IPC 和 preload 隔离", () => {
  const source = fs.readFileSync(new URL("../apps/desktop/src/main/index.ts", import.meta.url), "utf8");
  assert.match(source, /nodeIntegrationInSubFrames: false/);
  assert.match(source, /webviewTag: false/);
  assert.match(source, /denyBrowserPermissions\(session\.defaultSession\)/);
  assert.match(source, /on\("will-frame-navigate"/);
  assert.match(source, /on\("will-redirect"/);
  assert.match(source, /resourceType === "subFrame" && !browserFrameAllowed\(details\.url, devUrl\)/);
  assert.match(source, /event\.senderFrame === window\.webContents\.mainFrame/);
  assert.match(source, /session\.defaultSession\.on\("will-download", event => event\.preventDefault\(\)\)/);
});
