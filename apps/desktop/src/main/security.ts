// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export function cspFor(devServerUrl: string, nonce: string): string {
  const url = new URL(devServerUrl);
  if (url.protocol !== "http:" || !/^[A-Za-z0-9_-]{16,}$/.test(nonce)) throw new Error("开发页面需要 HTTP 地址与启动器生成的 nonce");
  const socket = new URL(url.origin);
  socket.protocol = "ws:";
  return `default-src 'self'; script-src 'self' ${url.origin} 'nonce-${nonce}'; style-src 'self' ${url.origin} 'nonce-${nonce}'; connect-src 'self' ${url.origin} ${socket.origin}; object-src 'none'; base-uri 'none'; frame-src 'none'`;
}

export function externalUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

export function isRendererReload(value: string, devServerUrl: string | undefined): boolean {
  return !!devServerUrl && value === new URL(devServerUrl).href;
}
