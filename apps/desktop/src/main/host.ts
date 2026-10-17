import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { CodeController, serializeFailure } from "./controller.ts";
import { adoptEnvironment, codeTargetConfig, DesktopError, selectEnvironment } from "./environment.ts";
import { handleRequest, ipcResult } from "./ipc.ts";
import { BrowserDocuments } from "./browser-documents.ts";
import { PersonalController } from "./personal-controller.ts";
import { loadPersonalConfig, savePersonalConfig } from "./personal-config.ts";
import { DesktopNotifications, type DesktopNotice } from "./notifications.ts";
import { pickAttachments } from "./attachments.ts";
import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";

export interface DesktopPlatform {
  publish(target: DesktopTarget, update: DesktopUpdate): void;
  focused(): boolean;
  notice(notice: DesktopNotice): void;
  badge(count: number): void;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-connection-startup.md
export class DesktopHost {
  private controller: CodeController | null = null;
  private initialization: Promise<void> | null = null;
  private environment: Promise<Awaited<ReturnType<typeof selectEnvironment>>> | null = null;
  private readonly environmentAbort = new AbortController();
  private personal: PersonalController | null = null;
  private personalInitialization: Promise<void> | null = null;
  private personalGeneration = 0;
  private closing: Promise<void> | null = null;
  private readonly subscribed = new Set<DesktopTarget>();
  private readonly lastState: Record<DesktopTarget, DesktopUpdate> = { code: { type: "state", state: "connecting" }, personal: { type: "state", state: "closed", detail: "尚未配置 Personal 连接" } };
  private readonly navigation = new Map<DesktopTarget, Extract<DesktopUpdate, { type: "navigate" }>>();
  private readonly attachmentConnections = new WeakMap<object, string>();
  private readonly notificationState: DesktopNotifications;
  private readonly browserDocuments: BrowserDocuments;

  constructor(private readonly repository: string, private readonly userData: string, private readonly platform: DesktopPlatform, private readonly prepareEnvironment = (signal: AbortSignal) => selectEnvironment(process.env, undefined, signal)) {
    this.browserDocuments = new BrowserDocuments([userData]);
    this.notificationState = new DesktopNotifications(platform.focused, platform.notice, platform.badge, (target, taskId) => {
      const source = target === "code" ? this.controller : this.personal;
      if (!source) throw new ControlClientError("connection_unavailable", "连接不可用", "not_sent");
      return source.request("get_task", { task_id: taskId });
    });
    this.warmEnvironment();
  }
  private publish(target: DesktopTarget, update: DesktopUpdate): void {
    this.notificationState.update(target, update);
    if (update.type === "state") this.lastState[target] = update;
    if (this.subscribed.has(target)) this.platform.publish(target, update);
  }
  private warmEnvironment(): NonNullable<DesktopHost["environment"]> {
    this.environment ??= this.prepareEnvironment(this.environmentAbort.signal);
    // 预热失败留给首次连接消费并报告；这里仅防止订阅前的未处理拒绝。
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
    const config = codeTargetConfig(this.repository, source);
    this.controller = new CodeController(config, update => this.publish("code", update), undefined, new PendingRequestStore(path.join(this.userData, "pending", "code", createHash("sha256").update(config.controlDir).digest("hex"))));
  }
  reconnectPersonal(replace = false): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.personalInitialization && !replace) return this.personalInitialization;
    const generation = ++this.personalGeneration;
    const previous = this.personalInitialization;
    const closing = this.personal?.close();
    this.personalInitialization = (async () => {
      try {
        await closing;
        await previous;
        if (this.closing || generation !== this.personalGeneration) return;
        const config = loadPersonalConfig(this.userData);
        if (!config) return;
        const source = await this.getEnvironment();
        if (this.closing || generation !== this.personalGeneration) return;
        this.personal = new PersonalController(config, this.userData, update => { if (generation === this.personalGeneration) this.publish("personal", update); }, source.env);
        await this.personal.reconnect();
      } catch (error) { if (generation === this.personalGeneration && !this.closing) this.publish("personal", { type: "state", state: "failed", error: serializeFailure(error) }); }
    })().finally(() => { if (generation === this.personalGeneration) this.personalInitialization = null; });
    return this.personalInitialization;
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
    if (target !== "code" && target !== "personal") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
    this.subscribed.add(target);
    this.publish(target, this.lastState[target]);
    const intent = this.navigation.get(target);
    if (intent) { this.navigation.delete(target); this.publish(target, intent); }
    if (target === "code" && (!this.controller || this.controller.status.state === "online")) void this.reconnect();
    if (target === "personal" && (!this.personal || this.personal.status.state === "online")) void this.reconnectPersonal();
  }
  navigate(notice: DesktopNotice): void {
    const update: Extract<DesktopUpdate, { type: "navigate" }> = { type: "navigate", instanceId: notice.instanceId, navigation: { sessionId: notice.sessionId, taskId: notice.taskId } };
    if (this.subscribed.has(notice.target)) this.publish(notice.target, update);
    else this.navigation.set(notice.target, update);
  }
  request(target: unknown, op: unknown, params: unknown) {
    // 本机文档能力属于宿主，不依赖 Code/Personal 的连接或后台文件权限。
    if (op === "desktop_browser_open" || op === "desktop_browser_release") return ipcResult(async () => {
      if (target !== "code" && target !== "personal") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1) throw new DesktopError("invalid_params", "本地预览参数无效，请重新打开文档。");
      if (this.closing) throw new DesktopError("browser_document_closed", "本地预览已关闭，请重新打开应用。");
      if (op === "desktop_browser_open" && "url" in params) return this.browserDocuments.open(params.url);
      if (op === "desktop_browser_release" && "id" in params) return this.browserDocuments.release(params.id);
      throw new DesktopError("invalid_params", "本地预览参数无效，请重新打开文档。");
    });
    return handleRequest(target, op, params, () => target === "personal" ? this.reconnectPersonal() : this.reconnect(), (op, params) => {
      if (target === "personal") {
        if (!this.personal) throw new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent");
        return this.personal.dispatch(op, params);
      }
      if (!this.controller) throw new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent");
      return this.controller.dispatch(op, params);
    }, (op, params) => {
      const source = target === "personal" ? this.personal : this.controller;
      if (!source?.submissions) throw new DesktopError("connection_unavailable", "请等待连接恢复后再处理原输入。");
      return source.submissions.local(op, params);
    }, async (op, params) => {
      if (op === "desktop_personal_config_read") return loadPersonalConfig(this.userData);
      const config = savePersonalConfig(this.userData, params);
      await this.reconnectPersonal(true);
      return config;
    });
  }
  private attachmentSource(target: unknown) {
    if (target !== "code" && target !== "personal") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
    const source = target === "personal" ? this.personal : this.controller;
    if (!source || source.status.state !== "online" || !source.instanceId() || !source.connectionIdentity()) throw new DesktopError("connection_unavailable", "请等待连接恢复后附加文件。");
    return source;
  }
  attachmentInstance(target: unknown = "code"): string {
    const source = this.attachmentSource(target);
    const connection = source.connectionIdentity()!;
    let id = this.attachmentConnections.get(connection);
    if (!id) { id = randomUUID(); this.attachmentConnections.set(connection, id); }
    return `${id}:${source.instanceId()}`;
  }
  pickAttachments(sessionId: unknown, pick: () => Promise<string[]>, expectedSelection?: string, target: unknown = "code") {
    const source = this.attachmentSource(target);
    if (typeof sessionId !== "string") throw new DesktopError("invalid_params", "请选择会话后附加文件。");
    if (expectedSelection !== undefined && this.attachmentInstance(target) !== expectedSelection) throw new DesktopError("attachment_instance_changed", "连接目标已变化，未附加文件；请重新选择。");
    const connection = source.connectionIdentity();
    const current = () => (target === "personal" ? this.personal : this.controller) === source && source.status.state === "online" && source.connectionIdentity() === connection;
    return pickAttachments(sessionId, {
      instanceId: () => current() ? source.instanceId() : null,
      pick,
      upload: params => {
        if (!current()) throw new DesktopError("attachment_instance_changed", "连接目标已变化，未附加文件；请重新选择。");
        return source.request("put_attachment", params);
      },
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    ++this.personalGeneration;
    this.controller?.close();
    this.environmentAbort.abort();
    this.closing = Promise.all([this.browserDocuments.close(), this.personal?.close(), this.personalInitialization, this.initialization, this.environment?.catch(() => { /* 退出取消的读取不再用于连接，连接期间的失败由消费方报告。 */ })]).then(() => {});
    return this.closing;
  }
}
