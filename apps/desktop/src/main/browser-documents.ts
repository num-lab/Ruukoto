import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isUtf8 } from "node:buffer";
import { DesktopError } from "./environment.ts";
import type { BrowserDocumentHandle, BrowserDocumentId } from "../shared/bridge.ts";

export const BROWSER_FILE_BYTES = 8 * 1024 * 1024;
export const BROWSER_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const BROWSER_DOCUMENT_REQUESTS = 256;
const MAX_DOCUMENTS = 8, MAX_READS = 16;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
type LocalFile = { bytes: Buffer; mime: string };
type DocumentRoot = { path: string; dev: number; ino: number };
type Document = { server: http.Server; root: DocumentRoot; token: string; host: string; name: string; entry: LocalFile; requests: number; bytes: number; closed: boolean; pending: Set<Promise<void>> };

function failure(code: string, message: string): never { throw new DesktopError(code, message); }
function same(before: fs.Stats, after: fs.Stats): boolean { return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode; }
function unchanged(before: fs.Stats, after: fs.Stats): boolean { return same(before, after) && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.nlink === after.nlink; }
function inside(root: string, file: string): boolean { const relative = path.relative(root, file); return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
async function io<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DesktopError) throw error;
    const code = error instanceof Error && "code" in error ? error.code : null;
    failure(code === "ENOENT" ? "browser_file_not_found" : "browser_file_unavailable", code === "ENOENT" ? "The local file no longer exists; check the path and try again." : "Couldn't read the local file; check permissions and try again.");
  }
}
function protectedRoot(value: string): string {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(protectedRoot(parent), path.basename(absolute));
  }
}
function fileAddress(value: unknown): URL {
  if (typeof value !== "string" || value.length > 8192 || value.includes("\\") || !/^file:\/\/(?:localhost)?\//i.test(value)) failure("invalid_browser_file_url", "Enter a valid local file URL.");
  let url: URL;
  try { url = new URL(value); }
  catch { failure("invalid_browser_file_url", "Enter a valid local file URL."); }
  if (url.protocol !== "file:" || url.host || url.username || url.password || url.search || url.pathname === "/" || url.pathname.startsWith("//") || /%2f|%5c/i.test(url.pathname)) failure("invalid_browser_file_url", "Enter a valid local file URL.");
  return url;
}

// Note: See .agents/notes/implemented/feature/2026-10-17-desktop-local-browser.md
// Note: See .agents/notes/implemented/simplification/2026-10-25-browser-path-names.md
export class BrowserDocuments {
  private readonly documents = new Map<BrowserDocumentId, Document>();
  private readonly opening = new Set<Promise<BrowserDocumentHandle>>();
  private readonly protectedRoots: string[];
  private closing: Promise<void> | null = null;
  private closed = false;
  private reads = 0;
  constructor(protectedPaths: string[]) { this.protectedRoots = protectedPaths.map(protectedRoot); }
  protectPaths(paths: string[]): void { this.protectedRoots.push(...paths.map(protectedRoot)); }
  private protect(target: string): void {
    if (this.protectedRoots.some(root => inside(root, target))) failure("browser_file_unsafe", "This file is in a protected scope and can't be previewed.");
  }
  private async locate(root: DocumentRoot, parts: string[]): Promise<{ target: string; chain: fs.Stats[] }> {
    let target = root.path;
    const first = await io(() => fs.promises.lstat(target));
    if (!first.isDirectory() || first.isSymbolicLink() || first.dev !== root.dev || first.ino !== root.ino) failure("browser_file_changed", "The document directory changed; reopen it.");
    const chain = [first];
    for (const [index, part] of parts.entries()) {
      target = path.join(target, part); this.protect(target);
      const stat = await io(() => fs.promises.lstat(target));
      if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) failure("browser_file_unsafe", "The file path contains a link or an unsafe directory and can't be previewed.");
      chain.push(stat);
    }
    this.protect(target);
    return { target, chain };
  }
  private async verify(root: DocumentRoot, parts: string[], previous: fs.Stats[]): Promise<void> {
    const current = await this.locate(root, parts);
    if (previous.some((stat, index) => !same(stat, current.chain[index]))) failure("browser_file_changed", "The file or directory changed while reading; reopen it.");
  }
  private async read(root: DocumentRoot, parts: string[], reserve: (size: number) => void): Promise<LocalFile> {
    const { target, chain } = await this.locate(root, parts), before = chain.at(-1)!;
    if (!before.isFile() || before.nlink !== 1) failure("browser_file_unsafe", "Choose a standalone regular file.");
    if (before.size > BROWSER_FILE_BYTES) failure("browser_file_too_large", "Local preview supports at most 8 MiB per file.");
    reserve(before.size);
    const file = await io(() => fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
    let bytes: Buffer;
    try {
      const opened = await io(() => file.stat());
      if (!unchanged(before, opened)) failure("browser_file_changed", "The file changed while opening; reopen it.");
      await this.verify(root, parts, chain);
      bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await io(() => file.read(bytes, length, bytes.length - length, length));
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await io(() => file.stat());
      if (length !== before.size || !unchanged(opened, after)) failure("browser_file_changed", "The file changed while reading; reopen it.");
      await this.verify(root, parts, chain);
      bytes = bytes.subarray(0, length);
    } finally { await io(() => file.close()); }
    const mime = MIME[path.extname(target).toLowerCase()] ?? "text/plain; charset=utf-8";
    if (mime.includes("charset=utf-8") && (!isUtf8(bytes) || bytes.includes(0))) failure("browser_file_unsupported", "This file format isn't supported for local preview yet.");
    return { bytes, mime };
  }
  open(value: unknown): Promise<BrowserDocumentHandle> {
    if (this.closed) return Promise.reject(new DesktopError("browser_document_closed", "Local preview closed; reopen the app."));
    if (this.documents.size + this.opening.size >= MAX_DOCUMENTS) return Promise.reject(new DesktopError("browser_document_limit", "Too many local documents open; close some browser tabs and try again."));
    const pending = this.prepare(value);
    this.opening.add(pending);
    void pending.then(() => this.opening.delete(pending), () => this.opening.delete(pending));
    return pending;
  }
  private async prepare(value: unknown): Promise<BrowserDocumentHandle> {
    const url = fileAddress(value);
    let target: string;
    try { target = fileURLToPath(url); }
    catch { failure("invalid_browser_file_url", "Enter a valid local file URL."); }
    if (target.includes("\0") || target.includes("\\")) failure("invalid_browser_file_url", "Enter a valid local file URL.");
    this.protect(target);
    const parent = await io(() => fs.promises.realpath(path.dirname(target)));
    this.protect(path.join(parent, path.basename(target)));
    const stat = await io(() => fs.promises.lstat(parent));
    const root = { path: parent, dev: stat.dev, ino: stat.ino }, name = path.basename(target);
    const entry = await this.read(root, [name], () => {});
    if (this.closed) failure("browser_document_closed", "Local preview closed; reopen the app.");
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 });
    server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 64; server.maxConnections = 16;
    server.setTimeout(5000, socket => socket.destroy());
    const document: Document = { server, root, token: randomBytes(32).toString("hex"), host: "", name, entry, requests: 0, bytes: 0, closed: false, pending: new Set() };
    server.on("request", (request, response) => {
      const pending = this.serve(document, request, response);
      document.pending.add(pending);
      void pending.then(() => document.pending.delete(pending), () => document.pending.delete(pending));
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    } catch { failure("browser_document_unavailable", "Couldn't open the local preview; try again later."); }
    if (this.closed) { await this.stop(document); failure("browser_document_closed", "Local preview closed; reopen the app."); }
    const address = server.address();
    if (!address || typeof address === "string") { await this.stop(document); failure("browser_document_unavailable", "Couldn't open the local preview; try again later."); }
    document.host = `127.0.0.1:${address.port}`;
    const id = randomUUID();
    this.documents.set(id, document);
    server.on("error", () => { void this.release(id); process.stderr.write("[ruukoto:desktop] Local document preview connection failed; reopen the document.\n"); });
    return { id, url: `http://${document.host}/${document.token}/${encodeURIComponent(name)}${url.hash}` };
  }
  private async serve(document: Document, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const fail = (status: number, message: string) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close" }); response.end(message); };
    let reading = false;
    try {
      if (document.closed || request.headers.host !== document.host) { fail(403, "Local preview unavailable."); return; }
      const raw = (request.url ?? "").split("?")[0];
      const prefix = `/${document.token}/`;
      if (!raw.startsWith(prefix)) { fail(403, "Local preview unavailable."); return; }
      if (request.headers.origin !== undefined && request.headers.origin !== "null") { fail(403, "This page has no local document read permission."); return; }
      if (request.headers.origin === "null") { response.setHeader("Access-Control-Allow-Origin", "null"); response.setHeader("Vary", "Origin"); }
      if (++document.requests > BROWSER_DOCUMENT_REQUESTS) { fail(429, "Too many local document requests; refresh the page."); return; }
      const parts = raw.slice(prefix.length).split("/").map(part => decodeURIComponent(part));
      if (parts.length > 64 || raw.length > 8192 || parts.some(part => !part || part === "." || part === ".." || /[/\\\0]/.test(part))) { fail(403, "Invalid local resource path."); return; }
      if (request.method === "OPTIONS") {
        if (request.headers.origin !== "null" || !["GET", "HEAD"].includes(String(request.headers["access-control-request-method"])) || request.headers["access-control-request-headers"]) { fail(405, "This request isn't supported."); return; }
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET, HEAD", "Cache-Control": "no-store" }); response.end(); return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { fail(405, "Local preview is read-only."); return; }
      if (this.reads >= MAX_READS) { fail(429, "Local document reads are busy; refresh the page."); return; }
      this.reads++; reading = true;
      const reserve = (size: number) => { if (document.bytes + size > BROWSER_DOCUMENT_BYTES) failure("browser_document_limit", "Local resource reads exceeded the budget; refresh the page."); document.bytes += size; };
      let file: LocalFile;
      if (parts.length === 1 && parts[0] === document.name) { reserve(document.entry.bytes.length); await this.locate(document.root, []); file = document.entry; }
      else file = await this.read(document.root, parts, reserve);
      if (document.closed || response.destroyed) return;
      response.writeHead(200, { "Content-Type": file.mime, "Content-Length": file.bytes.length, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox allow-scripts allow-forms; object-src 'none'" });
      response.end(request.method === "HEAD" ? undefined : file.bytes);
    } catch (error) {
      if (!response.destroyed) {
        if (error instanceof DesktopError) fail(error.code === "browser_document_limit" ? 429 : error.code === "browser_file_not_found" ? 404 : 403, error.message);
        else if (error instanceof URIError) fail(400, "Invalid local resource path.");
        else { fail(500, "The local resource is temporarily unavailable; refresh the page."); process.stderr.write("[ruukoto:desktop] Local document resource read failed; refresh the page.\n"); }
      }
    } finally { if (reading) this.reads--; }
  }
  private async stop(document: Document): Promise<void> {
    document.closed = true;
    const closing = new Promise<void>(resolve => document.server.close(() => resolve()));
    document.server.closeAllConnections();
    await closing;
    await Promise.allSettled([...document.pending]);
  }
  async release(id: unknown): Promise<void> {
    if (typeof id !== "string" || id.length > 128) failure("invalid_params", "Invalid local preview identifier; reopen the document.");
    const document = this.documents.get(id);
    if (!document) return;
    this.documents.delete(id);
    await this.stop(document);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => { await Promise.allSettled([...this.opening]); await Promise.all([...this.documents.keys()].map(id => this.release(id))); })();
    return this.closing;
  }
}
