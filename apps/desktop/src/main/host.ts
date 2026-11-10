import * as path from "node:path";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { CodeController, serializeFailure } from "./controller.ts";
import { adoptEnvironment, desktopBackendConfig, DesktopError, selectEnvironment } from "./environment.ts";
import { handleRequest, ipcResult } from "./ipc.ts";
import { BrowserDocuments } from "./browser-documents.ts";
import { DesktopNotifications, type DesktopNotice } from "./notifications.ts";
import { pickAttachments, stageAttachments, type StagedAttachment } from "./attachments.ts";
import { DesktopChatDrafts } from "./chat-drafts.ts";
import type { DesktopAttachment, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import { verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { Project } from "@ruukoto/core/types.ts";
import { spawn } from "node-pty";
import { TerminalManager, type PtyFactory } from "./terminal.ts";
import type { MyGoBrowserTransport } from "./browser-bridge.ts";
import type { DesktopBrowserEvent } from "@ruukoto/control/protocol.ts";

export interface DesktopPlatform {
  publish(target: DesktopTarget, update: DesktopUpdate): void | Promise<void>;
  focused(): boolean;
  notice(notice: DesktopNotice): void;
  badge(count: number): void;
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md
// Note: See .agents/notes/implemented/bug-fix/2026-10-17-desktop-connection-startup.md
export class DesktopHost {
  private controller: CodeController | null = null;
  private initialization: Promise<void> | null = null;
  private environment: Promise<Awaited<ReturnType<typeof selectEnvironment>>> | null = null;
  private readonly environmentAbort = new AbortController();
  private closing: Promise<void> | null = null;
  private readonly subscribed = new Set<DesktopTarget>();
  private readonly lastState: Record<DesktopTarget, DesktopUpdate> = { code: { type: "state", state: "connecting" } };
  private readonly navigation = new Map<DesktopTarget, Extract<DesktopUpdate, { type: "navigate" }>>();
  private readonly attachmentConnections = new WeakMap<object, string>();
  /** Draft attachment tokens hold local paths until the conversation exists. */
  private readonly draftAttachments = new Map<string, StagedAttachment>();
  private readonly draftUploads = new Map<string, Promise<DesktopAttachment[]>>();
  private chats: DesktopChatDrafts | null = null;
  private readonly workspaces = new Map<string, Project>();
  private readonly notificationState: DesktopNotifications;
  private readonly browserDocuments: BrowserDocuments;
  private readonly terminals: TerminalManager;
  private readonly terminalRoots = new Map<string, DirIdentity>();
  private terminalInstance: string | null = null;
  private terminalGeneration = 0;
  private terminalReset: Promise<void> = Promise.resolve();
  private readonly terminalOpening = new Set<string>();
  private readonly terminalCanceled = new Set<string>();

  constructor(private readonly repository: string, userData: string, private readonly platform: DesktopPlatform, private readonly prepareEnvironment = (signal: AbortSignal) => selectEnvironment(process.env, undefined, signal), terminalFactory: PtyFactory = spawn, private readonly browserTransport?: MyGoBrowserTransport) {
    this.browserDocuments = new BrowserDocuments([userData]);
    this.terminals = new TerminalManager(terminalFactory, update => this.platform.publish("code", update));
    this.notificationState = new DesktopNotifications(platform.focused, platform.notice, platform.badge, (target, taskId) => {
      const source = this.controller;
      if (!source) throw new ControlClientError("connection_unavailable", "Connection unavailable", "not_sent");
      return source.request("get_task", { task_id: taskId });
    }, (planId, offset) => {
      if (!this.controller) throw new ControlClientError("connection_unavailable", "Connection unavailable: run outcome unverified", "not_sent");
      return this.controller.request("code_schedule", { plan_id: planId, run_offset: offset });
    });
    this.warmEnvironment();
  }
  private publish(target: DesktopTarget, update: DesktopUpdate): void {
    if (update.type === "snapshot") {
      const instance = update.result.snapshot.instanceId;
      if (this.terminalInstance && (update.instanceChanged || this.terminalInstance !== instance)) this.resetTerminals();
      this.terminalInstance = instance;
      this.terminalRoots.clear();
      this.workspaces.clear();
      for (const project of update.result.snapshot.projects) {
        this.workspaces.set(project.id, project);
        if (project.rootDir) this.terminalRoots.set(project.id, project.rootDir);
      }
    }
    if (update.type === "event") {
      const body = update.event.body;
      if (body.type === "project.created" && body.rootDir) this.terminalRoots.set(body.projectId, body.rootDir);
      if (body.type === "project.created" && !this.workspaces.has(body.projectId)) this.workspaces.set(body.projectId, { id: body.projectId, name: body.name, rootDir: body.rootDir ?? null, managed: body.managed, createRequestId: body.createRequestId, instructionFiles: [], settingsVersion: 1, createdAt: update.event.createdAt });
    }
    if (update.type === "state" && update.state === "online") {
      void this.chats?.list().then(drafts => this.publish("code", { type: "chat_drafts", drafts })).catch(error => this.publish("code", { type: "chat_drafts", drafts: [], error: serializeFailure(error).message }));
    }
    this.notificationState.update(target, update);
    if (update.type === "state") this.lastState[target] = update;
    if (this.subscribed.has(target)) void Promise.resolve(this.platform.publish(target, update)).catch(() => { process.stderr.write("[ruukoto:desktop] UI update not delivered; reopen the app to verify the current state.\n"); });
  }
  private warmEnvironment(): NonNullable<DesktopHost["environment"]> {
    this.environment ??= this.prepareEnvironment(this.environmentAbort.signal);
    // First connection consumes and reports a failed warmup; suppress only an unhandled rejection.
    void this.environment.catch(() => {});
    return this.environment;
  }
  private async getEnvironment() {
    const reading = this.warmEnvironment();
    let source: Awaited<typeof reading>;
    try { source = await reading; }
    catch (error) { if (this.environment === reading) this.environment = null; throw error; }
    if (!this.closing) adoptEnvironment(source.env);
    return source;
  }
  private async initializeController(): Promise<void> {
    const source = await this.getEnvironment();
    if (this.closing) return;
    const config = await desktopBackendConfig(this.repository, source);
    if (this.closing) return;
    this.browserDocuments.protectPaths([config.profile.dataDir, config.profile.agentDir, config.profile.controlDir, config.profile.pendingDir]);
    this.controller = new CodeController(config, update => this.publish("code", update), undefined, new PendingRequestStore(config.profile.desktopPendingDir), this.browserTransport);
    this.chats = new DesktopChatDrafts(new PendingRequestStore(path.join(config.profile.desktopPendingDir, "chats")), () => this.controller, id => this.workspaces.get(id), this.draftAttachments);
  }
  private reconnect(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      if (!this.controller) {
        try { await this.initializeController(); }
        catch (error) { if (!this.closing) this.publish("code", { type: "state", state: "failed", error: serializeFailure(error) }); return; }
      }
      if (!this.closing) await this.controller!.reconnect();
    })().finally(() => { this.initialization = null; });
    return this.initialization;
  }
  subscribe(target: unknown): void {
    if (target !== "code") throw new DesktopError("target_unavailable", "This connection target is unavailable.");
    this.subscribed.add(target);
    if (this.controller) this.publish("code", { type: "profile", profile: { instanceId: this.controller.config.profile.instanceId, draftKey: this.controller.config.profile.desktopDraftKey } });
    this.resetTerminals();
    this.publish(target, this.lastState[target]);
    const intent = this.navigation.get(target);
    if (intent) { this.navigation.delete(target); this.publish(target, intent); }
    if ((!this.controller || this.controller.status.state === "online")) void this.reconnect();
  }
  /**
   * Native-browser page facts (Go→Node): uplinked to the control plane for the host to consume, and forwarded to the
   * renderer for right-panel updates (URL/title/gate state). The gate itself lives natively and doesn't depend on this path.
   */
  browserEvent(event: DesktopBrowserEvent): void {
    this.publish("code", { type: "browser_event", event });
    this.controller?.browserEvent(event);
  }
  navigate(notice: DesktopNotice): void {
    const update: Extract<DesktopUpdate, { type: "navigate" }> = { type: "navigate", instanceId: notice.instanceId, navigation: { sessionId: notice.sessionId, taskId: notice.taskId } };
    if (this.subscribed.has(notice.target)) this.publish(notice.target, update);
    else this.navigation.set(notice.target, update);
  }
  request(target: unknown, op: unknown, params: unknown) {
    // Local document access belongs to the host, independently of backend file permissions.
    if (op === "desktop_browser_open" || op === "desktop_browser_release") return ipcResult(async () => {
      if (target !== "code") throw new DesktopError("target_unavailable", "This connection target is unavailable.");
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1) throw new DesktopError("invalid_params", "Invalid local preview parameters; reopen the document.");
      if (this.closing) throw new DesktopError("browser_document_closed", "Local preview closed; reopen the app.");
      if (op === "desktop_browser_open" && "url" in params) return this.browserDocuments.open(params.url);
      if (op === "desktop_browser_release" && "id" in params) return this.browserDocuments.release(params.id);
      throw new DesktopError("invalid_params", "Invalid local preview parameters; reopen the document.");
    });
    return handleRequest(target, op, params, () => this.reconnect(), (op, params) => {
      if (!this.controller) throw new ControlClientError("connection_unavailable", "Connection unavailable: request not sent", "not_sent");
      return this.controller.dispatch(op, params);
    }, (op, params) => {
      if (op === "desktop_workspace_path") {
        if (Object.keys(params).length !== 2 || typeof params.workspace_id !== "string" || params.instance_id !== this.terminalInstance) throw new DesktopError("workspace_changed", "The workspace changed; reopen the chat.");
        const root = this.terminalRoots.get(params.workspace_id);
        if (!root) throw new DesktopError("workspace_unavailable", "The workspace isn't ready; restore the connection and try again.");
        return { path: verifyDirIdentitySync(root).cwdReal };
      }
      if (op === "desktop_chat_start" || op === "desktop_chat_drafts" || op === "desktop_chat_finish" || op === "desktop_chat_prepare_submission") {
        const chats = this.chats;
        if (!chats) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before sending.");
        if (op === "desktop_chat_drafts") return chats.list();
        if (op === "desktop_chat_finish") return chats.finish(params.request_id).then(() => chats.list()).then(drafts => this.publish("code", { type: "chat_drafts", drafts }));
        if (op === "desktop_chat_prepare_submission") {
          const pending = this.controller?.submissions?.store.list(true);
          if (pending?.corrupt.length || pending?.records.some(record => record.requestId === params.request_id && record.op === "submit")) throw new DesktopError("chat_submission_pending", "The first message is still unverified; verify the original submission before editing.");
          return chats.prepareSubmission(params).then(result => {
            if (result.accepted) void chats.list().then(drafts => this.publish("code", { type: "chat_drafts", drafts })).catch(() => { /* The next reconnect rechecks the accepted first message. */ });
            return result;
          });
        }
        return chats.start(params).then(result => {
          this.workspaces.set(result.project.id, result.project);
          if (result.project.rootDir) this.terminalRoots.set(result.project.id, result.project.rootDir);
          return result;
        });
      }
      return this.terminalRequest(op, params);
    });
  }
  resetTerminals(): void {
    ++this.terminalGeneration;
    this.terminalReset = this.terminalReset.then(() => this.terminals.reset());
    // TerminalManager reports failures; a later open consumes the retained rejection.
    void this.terminalReset.catch(() => {});
  }
  private async terminalRequest(op: string, params: Record<string, unknown>) {
    if (this.closing) throw new DesktopError("terminal_closed", "The terminal host closed; reopen the app.");
    const keys = op === "desktop_terminal_open" ? ["id", "workspace_id", "instance_id", "cols", "rows"] : op === "desktop_terminal_input" ? ["id", "data"] : op === "desktop_terminal_resize" ? ["id", "cols", "rows"] : ["id"];
    if (Object.keys(params).length !== keys.length || keys.some(key => !(key in params))) throw new DesktopError("invalid_params", "Invalid terminal parameters; reopen the terminal.");
    if (op === "desktop_terminal_input") return this.terminals.input(params.id, params.data);
    if (op === "desktop_terminal_resize") return this.terminals.resize(params.id, params.cols, params.rows);
    if (op === "desktop_terminal_kill") { if (typeof params.id === "string" && this.terminalOpening.has(params.id)) this.terminalCanceled.add(params.id); return this.terminals.kill(params.id); }
    const generation = this.terminalGeneration;
    if (typeof params.workspace_id !== "string" || params.instance_id !== this.terminalInstance || !this.terminalInstance) throw new DesktopError("terminal_workspace_changed", "The terminal workspace changed; select the workspace again.");
    const root = this.terminalRoots.get(params.workspace_id);
    if (!root) throw new DesktopError("terminal_workspace_missing", "The workspace isn't ready; connect ruukoto and select a workspace.");
    if (typeof params.id !== "string" || this.terminalOpening.has(params.id)) throw new DesktopError("invalid_params", "The terminal reference is invalid or still opening; switch to the original tab.");
    const id = params.id;
    this.terminalOpening.add(id);
    try {
      const environment = await this.getEnvironment();
      await this.terminalReset;
      if (this.closing || this.terminalCanceled.has(id) || generation !== this.terminalGeneration || this.terminalRoots.get(params.workspace_id) !== root) throw new DesktopError("terminal_workspace_changed", "The terminal workspace changed or the tab closed; select the workspace again.");
      return this.terminals.open(id, root, params.cols, params.rows, environment.env);
    } finally { this.terminalOpening.delete(id); this.terminalCanceled.delete(id); }
  }
  private attachmentSource(target: unknown) {
    if (target !== "code") throw new DesktopError("op_not_allowed", "Connect ruukoto before attaching files.");
    const source = this.controller;
    if (!source || source.status.state !== "online" || !source.instanceId() || !source.connectionIdentity()) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before attaching files.");
    return source;
  }
  attachmentInstance(target: unknown = "code"): string {
    const source = this.attachmentSource(target);
    const connection = source.connectionIdentity()!;
    let id = this.attachmentConnections.get(connection);
    if (!id) { id = randomUUID(); this.attachmentConnections.set(connection, id); }
    return `${id}:${source.instanceId()}`;
  }
  pickAttachments(sessionId: unknown, pick: () => Promise<string[]>, expectedSelection?: string, target: unknown = "code", draftTokens?: string[]) {
    const source = this.attachmentSource(target);
    if (typeof sessionId !== "string") throw new DesktopError("invalid_params", "Select a chat before attaching files.");
    if (expectedSelection !== undefined && this.attachmentInstance(target) !== expectedSelection) throw new DesktopError("attachment_instance_changed", "The connection target changed; files weren't attached. Choose again.");
    const connection = source.connectionIdentity();
    const current = () => this.controller === source && source.status.state === "online" && source.connectionIdentity() === connection;
    return pickAttachments(sessionId, {
      instanceId: () => current() ? source.instanceId() : null,
      pick,
      ...(draftTokens ? { attachmentId: (_file: string, index: number) => `att_${createHash("sha256").update(JSON.stringify([source.instanceId(), sessionId, draftTokens[index]])).digest("hex").slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")}` } : {}),
      upload: params => {
        if (!current()) throw new DesktopError("attachment_instance_changed", "The connection target changed; files weren't attached. Choose again.");
        return source.request("put_attachment", params);
      },
    });
  }
  /** Register selected files before conversation creation; returned tokens last for this application run. */
  pickDraftAttachments(pick: () => Promise<string[]>) {
    return pick().then(files => {
      const staged = stageAttachments(files);
      for (const item of staged) this.draftAttachments.set(item.token, item);
      return staged.map(({ token, name, size }) => ({ id: token, name, size }));
    });
  }
  uploadDraftAttachments(sessionId: unknown, tokens: unknown, target: unknown = "code") {
    if (!Array.isArray(tokens) || tokens.some(token => typeof token !== "string")) throw new DesktopError("invalid_params", "Invalid attachment references; choose again.");
    const source = this.attachmentSource(target), instanceId = source.instanceId()!;
    if (typeof sessionId !== "string" || !sessionId) throw new DesktopError("invalid_params", "Select a chat before attaching files.");
    const cached = this.chats?.upload(instanceId, sessionId, tokens);
    if (cached) return Promise.resolve(cached);
    const uploadKey = JSON.stringify([instanceId, sessionId, tokens]);
    const pending = this.draftUploads.get(uploadKey);
    if (pending) return pending;
    this.chats?.verifyUpload(instanceId, sessionId, tokens);
    const files = tokens.map(token => this.draftAttachments.get(token)?.path);
    if (files.some(file => file === undefined)) throw new DesktopError("attachment_expired", "The attachment expired; choose it again.");
    for (const file of files) if (file && file.startsWith(`${source.config.profile.desktopPendingDir}${path.sep}`) && fs.realpathSync(file) !== file) throw new DesktopError("chat_attachment_unavailable", "The first-message attachment snapshot changed; check the original profile pending directory and try again.");
    const uploading = this.pickAttachments(sessionId, async () => files as string[], undefined, target, tokens).then(attachments => {
      this.chats?.uploaded(instanceId, sessionId, tokens, attachments);
      return attachments;
    }).catch(error => {
      this.draftUploads.delete(uploadKey);
      throw error;
    });
    this.draftUploads.set(uploadKey, uploading);
    return uploading;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller?.close();
    this.environmentAbort.abort();
    this.closing = Promise.all([this.terminals.close(), this.terminalReset, this.browserDocuments.close(), this.initialization, this.environment?.catch(() => { /* Aborted reads are unused after exit; connection consumers report earlier failures. */ })]).then(() => {});
    return this.closing;
  }
}
