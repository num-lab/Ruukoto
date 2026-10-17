import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodeState } from "./code-state.ts";
import { ArrowLeft, ArrowRight, ChevronRight, FileCode2, FileText, Folder, Image, Loader2, RotateCw } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { browserAddress, moveBrowser, navigateBrowser, type BrowserNavigation } from "./browser-navigation.ts";
import { highlightSource } from "./source-highlighting.ts";
import { startFilesRefresh } from "./files-refresh.ts";
import type { InspectorTab } from "./inspector.ts";
import type { PreviewFile } from "./read-snapshot.ts";
import { startBrowserDocument, type BrowserDocumentState } from "./browser-document.ts";
import type { DesktopBridge, DesktopTarget } from "../shared/bridge.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
function LocalBrowserDocument({ url, target, request }: { url: string; target: DesktopTarget; request?: DesktopBridge["request"] }) {
  const [state, setState] = useState<BrowserDocumentState | null>(null);
  useEffect(() => {
    const source = request ?? window.ruukoto?.request;
    if (!source) { setState({ error: "本地文件预览需要桌面宿主。" }); return; }
    return startBrowserDocument(source, target, url, setState);
  }, [request, target, url]);
  if (!state) return <div className="file-panel-empty" role="status">正在打开本地文档…</div>;
  return "error" in state ? <div className="file-panel-empty" role="alert">{state.error}</div> : <iframe title="本地文档预览" src={state.document.url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />;
}

export function BrowserPanel({ navigation, onChange, target = "code", request }: { navigation: BrowserNavigation; onChange: (navigation: BrowserNavigation) => void; target?: DesktopTarget; request?: DesktopBridge["request"] }) {
  const url = navigation.history[navigation.index];
  return <section className="browser-panel" aria-label="内置浏览器">
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); onChange(navigateBrowser(navigation, navigation.draft)); }}>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="后退" disabled={navigation.index === 0} onClick={() => onChange(moveBrowser(navigation, -1))}><ArrowLeft /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="前进" disabled={navigation.index === navigation.history.length - 1} onClick={() => onChange(moveBrowser(navigation, 1))}><ArrowRight /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="刷新网页" onClick={() => onChange({ ...navigation, draft: url === "about:blank" ? "" : url, revision: navigation.revision + 1, error: false })}><RotateCw /></Button>
      <Input aria-label="网页地址" aria-invalid={navigation.error} aria-describedby={navigation.error ? "browser-address-error" : undefined} inputMode="url" autoComplete="off" spellCheck={false} placeholder="输入网址" value={navigation.draft} onChange={event => onChange({ ...navigation, draft: event.target.value, error: false })} />
    </form>
    {navigation.error && <p id="browser-address-error" className="browser-error" role="alert">地址无效，请检查后重试。</p>}
    {url.startsWith("file:") ? <LocalBrowserDocument key={`${navigation.revision}:${url}`} url={url} target={target} request={request} /> : new URL(url).origin === window.location.origin && window.location.protocol !== "file:" ? <div className="embedded-demo-notice"><p>此地址是桌面界面本身。</p><p>请在地址栏输入要预览的网页地址。</p></div> : <iframe key={`${navigation.revision}:${url}`} title="网页预览" src={url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />}
  </section>;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-17-desktop-file-tree-loading.md
function DirectoryFolder({ model, workspaceId, path, name }: { model: CodeState; workspaceId: string; path: string; name: string }) {
  const inspector = model.inspector, key = inspector.fileKey(workspaceId, path);
  const state = inspector.directories.get(key), requested = inspector.folders.get(key) ?? false;
  const open = requested && !!(state?.value || state?.error);
  return <Collapsible asChild open={open} onOpenChange={() => {
    inspector.folders.set(key, !requested);
    if (!requested) void inspector.loadDirectory(workspaceId, path);
    model.refresh();
  }}><li><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="file-tree-row" aria-label={path} aria-busy={state?.loading || undefined}><ChevronRight className={open ? "rotate-90" : ""} /><Folder /><span>{name}</span>{state?.loading && <span className="file-tree-loading" role="status" aria-label="正在加载文件夹"><Loader2 className="animate-spin" aria-hidden="true" /></span>}</Button></CollapsibleTrigger><CollapsibleContent asChild><ul><Directory model={model} workspaceId={workspaceId} path={path} /></ul></CollapsibleContent></li></Collapsible>;
}

function Directory({ model, workspaceId, path }: { model: CodeState; workspaceId: string; path: string }) {
  const inspector = model.inspector;
  const state = inspector.directories.get(inspector.fileKey(workspaceId, path));
  useEffect(() => { void inspector.loadDirectory(workspaceId, path); }, [inspector, workspaceId, path, state]);
  return <>{state?.error && <li className="file-panel-empty"><p role="alert">{state.error}</p><Button variant="ghost" size="sm" onClick={() => void inspector.loadDirectory(workspaceId, path, true)}>重试</Button></li>}{!state || state.loading && !state.value ? <li className="file-panel-empty" role="status" aria-label="正在加载文件树"><Loader2 className="animate-spin" aria-hidden="true" /></li> : state.value ? <>{state.value.entries.map(node => node.kind === "directory" ? <DirectoryFolder key={node.path} model={model} workspaceId={workspaceId} path={node.path} name={node.name} /> : <li key={node.path}><Button type="button" variant="ghost" className="file-tree-row file-tree-file" aria-label={`预览 ${node.path}`} onClick={() => inspector.openFile(workspaceId, node.path)}>{/\.(png|jpe?g|gif|webp)$/i.test(node.name) ? <Image /> : /\.md$/i.test(node.name) ? <FileText /> : <FileCode2 />}<span>{node.name}</span></Button></li>)}{state.value.truncated && <li className="file-panel-empty">此目录只显示前 200 项。</li>}</> : null}</>;
}

export function WorkspaceFiles({ model, workspaceId, active = true }: { model: CodeState; workspaceId: string; active?: boolean }) {
  const name = model.view.projects.find(project => project.id === workspaceId)?.name ?? "工作区";
  const online = model.status.state === "online";
  useEffect(() => { if (active && online) return startFilesRefresh(model.inspector, workspaceId); }, [model.inspector, workspaceId, active, online]);
  return <section className="workspace-files" aria-label="工作区文件"><div className="file-panel-heading"><Folder /><span>{name}</span></div><nav aria-label={`${name} 文件`} className="file-tree"><ul>{active && online && <Directory model={model} workspaceId={workspaceId} path="" />}</ul></nav></section>;
}

export function ReadSnapshotPreview({ model, tab }: { model: CodeState; tab: Extract<InspectorTab, { kind: "read-snapshot" }> }) {
  const state = model.inspector.snapshots.get(tab.id);
  useEffect(() => { void model.inspector.loadReadSnapshot(tab); }, [model.inspector, tab, state]);
  if (!state || state.loading) return <div className="file-panel-empty">正在读取 Read 快照…</div>;
  if (state.error) return <div className="file-panel-empty"><p role="alert">{state.error}</p><Button variant="ghost" size="sm" onClick={() => void model.inspector.loadReadSnapshot(tab, true)}>重试</Button></div>;
  return <><p className="file-panel-empty" role="status">Read 时捕获的版本{state.partial ? " · 仅捕获了部分内容" : ""}{state.truncated ? " · 仅显示前 256 KiB" : ""}</p><FilePreview file={state.file} path={tab.path} mode={tab.mode} onMode={mode => { tab.mode = mode; model.refresh(); }} onFiles={() => model.inspector.openFiles()} onUrl={url => model.inspector.openBrowser(url)} /></>;
}

export function WorkspaceFile({ model, workspaceId, path, mode, onMode }: { model: CodeState; workspaceId: string; path: string; mode: "preview" | "source"; onMode: (mode: "preview" | "source") => void }) {
  const inspector = model.inspector;
  const state = inspector.files.get(inspector.fileKey(workspaceId, path));
  useEffect(() => { void inspector.loadFile(workspaceId, path); }, [inspector, workspaceId, path, state]);
  if (!state || state.loading) return <div className="file-panel-empty">正在读取…</div>;
  if (state.error) return <div className="file-panel-empty"><p role="alert">{state.error}</p><Button variant="ghost" size="sm" onClick={() => void inspector.loadFile(workspaceId, path, true)}>重试</Button></div>;
  return <FilePreview file={state.value} path={path} mode={mode} onMode={onMode} onFiles={() => inspector.openFiles()} onUrl={url => inspector.openBrowser(url)} />;
}

function SourcePreview({ content, path }: { content: string; path: string }) {
  const highlighted = useMemo(() => highlightSource(path, content), [path, content]);
  return <div className="file-source selectable-text" role="region" aria-label="文件源码" tabIndex={0}><div className="file-lines"><div className="file-source-gutter" aria-hidden="true">{(content === "" ? [] : content.split("\n")).map((_line, index) => <span className="file-line" key={index}>{index + 1}</span>)}</div><pre>{highlighted === null ? <code>{content}</code> : <code dangerouslySetInnerHTML={{ __html: highlighted }} />}</pre></div></div>;
}

function ImagePreview({ file }: { file: Extract<PreviewFile, { kind: "image" }> }) {
  const [failed, setFailed] = useState(false);
  return <div className="file-image">{failed ? <p role="alert">图片无法显示，请重新打开文件。</p> : <img src={file.dataUrl} alt={file.path} onError={() => setFailed(true)} />}</div>;
}

export function FilePreview({ file, path, mode, onMode, onFiles, onUrl }: { file: PreviewFile | undefined; path: string; mode: "preview" | "source"; onMode: (mode: "preview" | "source") => void; onFiles: () => void; onUrl: (url: string) => void }) {
  return <section className="file-preview" aria-label="文件预览">
    <div className="file-panel-heading"><code>{path}</code>{file?.kind === "markdown" && <div className="file-preview-modes"><Button type="button" variant="ghost" size="xs" aria-pressed={mode === "preview"} onClick={() => onMode("preview")}>预览</Button><Button type="button" variant="ghost" size="xs" aria-pressed={mode === "source"} onClick={() => onMode("source")}>源码</Button></div>}</div>
    {!file ? <div className="file-panel-empty"><p>文件不可用</p><Button type="button" variant="ghost" size="sm" onClick={onFiles}>打开文件树</Button></div>
      : file.kind === "unsupported" ? <div className="file-panel-empty"><FileText /><p>暂不支持预览此文件</p></div>
      : file.kind === "image" ? <ImagePreview key={file.path} file={file} />
      : file.kind === "markdown" && mode === "preview" ? <div className="file-markdown selectable-text"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => { const url = href && /^https?:\/\//i.test(href) ? browserAddress(href) : null; return url ? <button type="button" className="file-preview-link" onClick={() => onUrl(url)}>{children}</button> : <span>{children}</span>; },
        img: ({ alt }) => <span className="text-muted-foreground">[图片{alt ? `：${alt}` : ""}]</span>,
      }}>{file.content}</Markdown></div> : <SourcePreview path={file.path} content={file.content} />}
  </section>;
}
