import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { CodeState } from "./code-state.ts";
import { ArrowLeft, ArrowRight, ChevronRight, FileCode2, FileText, Folder, Image, RotateCw } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { browserAddress, moveBrowser, navigateBrowser, type BrowserNavigation } from "./browser-navigation.ts";
import { highlightSource } from "./source-highlighting.ts";
type PreviewFile = OpResult<"read_workspace_file">;

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
export function BrowserPanel({ navigation, onChange }: { navigation: BrowserNavigation; onChange: (navigation: BrowserNavigation) => void }) {
  const url = navigation.history[navigation.index];
  return <section className="browser-panel" aria-label="内置浏览器">
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); onChange(navigateBrowser(navigation, navigation.draft)); }}>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="后退" disabled={navigation.index === 0} onClick={() => onChange(moveBrowser(navigation, -1))}><ArrowLeft /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="前进" disabled={navigation.index === navigation.history.length - 1} onClick={() => onChange(moveBrowser(navigation, 1))}><ArrowRight /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="刷新网页" onClick={() => onChange({ ...navigation, draft: url === "about:blank" ? "" : url, revision: navigation.revision + 1, error: false })}><RotateCw /></Button>
      <Input aria-label="网页地址" aria-invalid={navigation.error} aria-describedby={navigation.error ? "browser-address-error" : undefined} inputMode="url" autoComplete="off" spellCheck={false} placeholder="输入网址" value={navigation.draft} onChange={event => onChange({ ...navigation, draft: event.target.value, error: false })} />
    </form>
    {navigation.error && <p id="browser-address-error" className="browser-error" role="alert">请输入 http 或 https 网址，且不要包含账号密码。</p>}
    {new URL(url).origin === window.location.origin && window.location.protocol !== "file:" ? <div className="embedded-demo-notice"><p>此地址是桌面界面本身。</p><p>请在地址栏输入要预览的网页地址。</p></div> : <iframe key={`${navigation.revision}:${url}`} title="网页预览" src={url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />}
    <p className="browser-note">部分网站不允许嵌入。</p>
  </section>;
}

function Directory({ model, workspaceId, path }: { model: CodeState; workspaceId: string; path: string }) {
  const inspector = model.inspector;
  const state = inspector.directories.get(inspector.fileKey(workspaceId, path));
  useEffect(() => { void inspector.loadDirectory(workspaceId, path); }, [inspector, workspaceId, path, state]);
  return <>{state?.loading ? <li className="file-panel-empty">正在读取…</li> : state?.error ? <li className="file-panel-empty"><p role="alert">{state.error}</p><Button variant="ghost" size="sm" onClick={() => void inspector.loadDirectory(workspaceId, path, true)}>重试</Button></li> : state?.value ? <>{state.value.entries.map(node => node.kind === "directory" ? <Collapsible asChild key={node.path} open={inspector.folders.get(inspector.fileKey(workspaceId, node.path)) ?? false} onOpenChange={open => { inspector.folders.set(inspector.fileKey(workspaceId, node.path), open); model.refresh(); }}><li><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="file-tree-row" aria-label={node.path}><ChevronRight className={inspector.folders.get(inspector.fileKey(workspaceId, node.path)) ? "rotate-90" : ""} /><Folder /><span>{node.name}</span></Button></CollapsibleTrigger><CollapsibleContent asChild><ul><Directory model={model} workspaceId={workspaceId} path={node.path} /></ul></CollapsibleContent></li></Collapsible> : <li key={node.path}><Button type="button" variant="ghost" className="file-tree-row file-tree-file" aria-label={`预览 ${node.path}`} onClick={() => inspector.openFile(workspaceId, node.path)}>{/\.(png|jpe?g|gif|webp)$/i.test(node.name) ? <Image /> : /\.md$/i.test(node.name) ? <FileText /> : <FileCode2 />}<span>{node.name}</span></Button></li>)}{state.value.truncated && <li className="file-panel-empty">此目录只显示前 200 项。</li>}{!state.value.entries.length && <li className="file-panel-empty">暂无文件</li>}</> : null}</>;
}

export function WorkspaceFiles({ model, workspaceId }: { model: CodeState; workspaceId: string }) {
  const name = model.view.projects.find(project => project.id === workspaceId)?.name ?? "工作区";
  return <section className="workspace-files" aria-label="工作区文件"><div className="file-panel-heading"><Folder /><span>{name}</span></div><nav aria-label={`${name} 文件`} className="file-tree"><ul><Directory model={model} workspaceId={workspaceId} path="" /></ul></nav></section>;
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
