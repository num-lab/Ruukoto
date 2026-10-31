export type PreviewFile = { path: string } & (
  | { kind: "text" | "markdown"; content: string }
  | { kind: "image"; src: string }
  | { kind: "unsupported" }
);
export type FileNode = { name: string; path: string } & (
  | { kind: "directory"; children: FileNode[] }
  | { kind: "file"; file: PreviewFile }
);
export type BrowserNavigation = { history: string[]; index: number; draft: string; revision: number; error: boolean };

const files: Record<string, PreviewFile[]> = {
  "ws-fumo": [
    { path: "README.md", kind: "markdown", content: "# Fumotravel\n\n新干线电子车票的离线体验演示。\n\n## 本地缓存\n\n- 使用 IndexedDB 保存车票区间。\n- 断网时读取缓存，重连后合并 HLC 时间戳。\n- 在时间线上展示离线状态。\n\n```ts\nconst { segments, offline } = await syncPassSegments(passId);\n```\n\n本目录为只读样例，不连接真实服务。\n" },
    { path: "package.json", kind: "text", content: '{\n  "name": "fumotravel-web",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test:unit": "vitest"\n  }\n}\n' },
    { path: "src/lib/sync/indexeddb.ts", kind: "text", content: 'import { idbGetSegments, idbPutSegments } from "../cache";\nimport { fetchPassSegments } from "../api";\nimport { reconcileHlcClock } from "./hlc";\n\nexport async function syncPassSegments(passId: string) {\n  const local = await idbGetSegments(passId);\n  if (!navigator.onLine) {\n    return { segments: local, offline: true };\n  }\n\n  const remote = await fetchPassSegments(passId);\n  const merged = reconcileHlcClock(local, remote);\n  await idbPutSegments(passId, merged);\n  return { segments: merged, offline: false };\n}\n' },
    { path: "src/components/PassTimeline.tsx", kind: "text", content: 'type Segment = { id: string; departure: string; arrival: string };\n\nexport function PassTimeline({ segments, offline }: {\n  segments: Segment[];\n  offline: boolean;\n}) {\n  return (\n    <section aria-label="车票行程">\n      {offline && <span>离线缓存</span>}\n      <ol>\n        {segments.map(segment => (\n          <li key={segment.id}>\n            {segment.departure} → {segment.arrival}\n          </li>\n        ))}\n      </ol>\n    </section>\n  );\n}\n' },
    { path: "src/utils/date-jst.ts", kind: "text", content: 'export const jstFormatter = new Intl.DateTimeFormat("ja-JP", {\n  timeZone: "Asia/Tokyo",\n  hour: "2-digit",\n  minute: "2-digit",\n});\n\nexport function formatDeparture(date: Date) {\n  return `${jstFormatter.format(date)} JST`;\n}\n' },
    { path: "public/pass.svg", kind: "image", src: "/sample-pass.svg" },
    { path: "public/pass.pdf", kind: "unsupported" },
    { path: "notes.txt", kind: "text", content: "" },
  ],
  "ws-nexus": [
    { path: "README.md", kind: "markdown", content: "# Nexus runtime\n\nJSON-RPC 连接池与共享环形缓冲区的只读样例。\n\n- stdio 连接复用\n- 断线后的指数退避\n- 零拷贝数据传递\n" },
    { path: "src/pool/manager.rs", kind: "text", content: 'use std::time::Duration;\n\npub struct ConnectionPool {\n    pub max_connections: usize,\n    pub backoff: Duration,\n}\n\nimpl ConnectionPool {\n    pub fn new() -> Self {\n        Self {\n            max_connections: 8,\n            backoff: Duration::from_millis(250),\n        }\n    }\n}\n' },
    { path: "src/ipc/protocol.ts", kind: "text", content: 'export type RpcRequest = {\n  jsonrpc: "2.0";\n  id: number;\n  method: string;\n  params?: Record<string, unknown>;\n};\n' },
  ],
  "ws-eval": [
    { path: "README.md", kind: "markdown", content: "# Eval harness\n\n隔离运行评测任务的只读样例。\n" },
    { path: "harness/sandbox/docker_pool.py", kind: "text", content: 'from dataclasses import dataclass\n\n@dataclass\nclass SandboxConfig:\n    image: str = "python:3.12-slim"\n    pool_size: int = 4\n    timeout_seconds: int = 60\n' },
  ],
  "ws-menubar": [
    { path: "README.md", kind: "markdown", content: "# MenuBarKit\n\n菜单栏弹出窗口的只读样例。\n" },
    { path: "Sources/MenuBarKit/PopoverWindow.swift", kind: "text", content: 'import AppKit\n\nfinal class PopoverWindow: NSPanel {\n    override var canBecomeKey: Bool { true }\n\n    func show(relativeTo point: NSPoint) {\n        setFrameTopLeftPoint(point)\n        makeKeyAndOrderFront(nil)\n    }\n}\n' },
  ],
};

// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-inspector-tools.md
export function workspaceFiles(workspaceId: string): PreviewFile[] {
  return files[workspaceId] ?? [];
}

export function fileTree(files: PreviewFile[]): FileNode[] {
  const roots: FileNode[] = [];
  for (const file of files) {
    let siblings = roots;
    let path = "";
    const segments = file.path.split("/");
    for (const [index, name] of segments.entries()) {
      path = path ? `${path}/${name}` : name;
      if (index === segments.length - 1) siblings.push({ kind: "file", name, path, file });
      else {
        let directory = siblings.find(node => node.kind === "directory" && node.path === path);
        if (!directory) { directory = { kind: "directory", name, path, children: [] }; siblings.push(directory); }
        if (directory.kind === "directory") siblings = directory.children;
      }
    }
  }
  function sort(nodes: FileNode[]): FileNode[] {
    return nodes.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)).map(node => node.kind === "directory" ? { ...node, children: sort(node.children) } : node);
  }
  return sort(roots);
}

export function fileTabId(workspaceId: string, path: string): string {
  return `file:${workspaceId}:${path}`;
}

export function browserAddress(value: string): string | null {
  const address = value.trim();
  if (!address) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(address);
  const qualified = /^[a-z][a-z\d+.-]*:/i.test(address);
  let url: URL;
  try { url = new URL(local ? `http://${address}` : qualified ? address : `https://${address}`); }
  catch { return null; }
  if (url.protocol === "file:") {
    if (address.includes("\\") || !/^file:\/\/(?:localhost)?\//i.test(address) || url.host || url.username || url.password || url.search || url.pathname === "/" || url.pathname.startsWith("//") || /%2f|%5c/i.test(url.pathname)) return null;
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return null; }
    return /[\\\0]/.test(pathname) ? null : url.href;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
}

export function browserNavigation(url: string): BrowserNavigation {
  return { history: [url], index: 0, draft: url, revision: 0, error: false };
}

export function isDemoEntry(address: string, appOrigin: string): boolean {
  const url = new URL(address);
  return url.origin === appOrigin && (url.pathname === "/" || url.pathname === "/index.html");
}

export function navigateBrowser(state: BrowserNavigation, address: string): BrowserNavigation {
  const url = browserAddress(address);
  if (!url) return { ...state, draft: address, error: true };
  if (url === state.history[state.index]) return { ...state, draft: url, revision: state.revision + 1, error: false };
  const history = [...state.history.slice(0, state.index + 1), url];
  return { history, index: history.length - 1, draft: url, revision: state.revision + 1, error: false };
}

export function moveBrowser(state: BrowserNavigation, direction: -1 | 1): BrowserNavigation {
  const index = state.index + direction;
  return index < 0 || index >= state.history.length ? state : { ...state, index, draft: state.history[index], error: false };
}
