/**
 * /queue 面板（coding-message-control）：按持久 queue_order 展示排队输入，
 * 经 task_queue / queue_reorder / steer_task 操作逐项上移/下移与转为引导。
 * 顺序与可转引导集合一律取服务端回执（reorderableTaskIds/steerableTaskIds），
 * 客户端不自行推断资格；修订冲突时刷新后以实际顺序重试。
 */

import { SelectList, Text, matchesKey, type Component, type SelectItem } from "@earendil-works/pi-tui";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

type QueueDetail = OpResult<"task_queue">;

interface Deps {
  request: ControlConnection["request"];
  sessionId: () => string | null;
  online: () => boolean;
  retrieve: (taskId: string, revision: number) => Promise<void>;
  /** 输入气泡标题（按 TaskView 的正文/请求 ID），未知返回 null。 */
  taskLabel: (taskId: string) => string | null;
  render: () => void;
  close: () => void;
}

export class TaskQueuePanel implements Component {
  private detail: QueueDetail | null = null;
  private selected: string | null = null;
  private screen: "root" | "item" = "root";
  private list: SelectList | null = null;
  private message = "";
  private busy = false;
  private generation = 0;
  private sessionId: string | null = null;
  constructor(private readonly deps: Deps) {}
  invalidate(): void {}

  async refresh(): Promise<void> {
    const sessionId = this.deps.sessionId();
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId; this.selected = null; this.screen = "root"; this.message = "";
    }
    const generation = ++this.generation;
    if (!sessionId || !this.deps.online()) { this.detail = null; this.build(); return; }
    try {
      const detail = await this.deps.request("task_queue", { session_id: sessionId });
      if (generation !== this.generation || this.deps.sessionId() !== sessionId) return;
      this.detail = detail;
      if (this.selected && !detail.queue.tasks.some(item => item.taskId === this.selected)) { this.selected = null; this.screen = "root"; }
    } catch (error) { if (generation === this.generation) this.message = `队列查询失败：${(error as Error).message}；按 r 重新查询。`; }
    if (generation === this.generation) this.build();
  }

  private reorderable(): string[] { return this.detail?.reorderableTaskIds ?? []; }
  // 回退引导按普通队首消息展示，不加状态标签（规格：不为正常回退新增标签）
  private label(taskId: string, index: number): string {
    return `#${index + 1} ${this.deps.taskLabel(taskId) ?? taskId.slice(0, 10)}`;
  }

  private choices(items: (SelectItem & { pick: () => void })[]): void {
    const cleanItems = items.map(item => ({ ...item, label: sanitizeForDisplay(item.label).replace(/\s+/g, " ") }));
    const list = new SelectList(cleanItems, 10, { selectedPrefix: text => `\x1b[36m${text}\x1b[0m`, selectedText: text => text, description: text => text, scrollInfo: text => text, noMatch: text => text });
    list.onSelect = item => items.find(choice => choice.value === item.value)?.pick();
    list.onCancel = () => this.back(); this.list = list;
  }

  private build(): void {
    const detail = this.detail;
    if (this.screen === "root" || !detail) {
      const reorderable = this.reorderable();
      this.choices([...(detail?.queue.tasks ?? []).map((item, index) => ({
        value: item.taskId,
        label: this.label(item.taskId, index) + (reorderable.includes(item.taskId) ? "" : "（不可重排）"),
        pick: () => { this.selected = item.taskId; this.screen = "item"; this.build(); },
      })),
        { value: "$refresh", label: "刷新", pick: () => void this.refresh() },
        { value: "$close", label: "返回聊天", pick: () => this.deps.close() }]);
      return;
    }
    const id = this.selected!;
    const order = this.reorderable();
    const index = order.indexOf(id);
    const steerable = detail.steerableTaskIds.includes(id);
    this.choices([
      ...(index > 0 ? [{ value: "$up", label: "上移", pick: () => void this.move(id, -1) }] : []),
      ...(index >= 0 && index < order.length - 1 ? [{ value: "$down", label: "下移", pick: () => void this.move(id, 1) }] : []),
      ...(steerable ? [{ value: "$steer", label: "转为引导（接入当前任务下一边界）", pick: () => void this.steer(id) }] : []),
      ...(detail.queue.retrievableTaskIds.includes(id) ? [{ value: "$retrieve", label: "取回并编辑", pick: () => void this.deps.retrieve(id, detail.queue.revision) }] : []),
      { value: "$back", label: "返回队列", pick: () => this.back() },
    ]);
    this.deps.render();
  }

  private async move(taskId: string, delta: -1 | 1): Promise<void> {
    if (this.busy || !this.detail) return;
    const order = this.reorderable();
    const index = order.indexOf(taskId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= order.length) return;
    this.busy = true; this.message = "正在重排…"; this.deps.render();
    const ids = [...order];
    [ids[index], ids[next]] = [ids[next]!, ids[index]!];
    try {
      await this.deps.request("queue_reorder", { session_id: this.sessionId!, task_ids: ids, expected_revision: this.detail.queue.revision });
      this.message = "";
    } catch (error) { this.message = `重排失败：${(error as Error).message}`; }
    this.busy = false; await this.refresh();
  }

  private async steer(taskId: string): Promise<void> {
    if (this.busy || !this.detail) return;
    this.busy = true; this.message = "正在转为引导…"; this.deps.render();
    try {
      await this.deps.request("steer_task", { task_id: taskId, expected_queue_revision: this.detail.queue.revision });
      this.message = "已登记引导：将在目标任务下一边界接入，错过则回到队首。";
      this.screen = "root"; this.selected = null;
    } catch (error) { this.message = `转为引导失败：${(error as Error).message}`; }
    this.busy = false; await this.refresh();
  }

  private back(): void {
    if (this.busy) return;
    if (this.screen === "item") { this.screen = "root"; this.selected = null; this.build(); }
    else this.deps.close();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.back(); return; }
    if (data === "r") void this.refresh();
    else if (data === "q" && this.screen === "root") this.deps.close();
    else this.list?.handleInput(data);
    this.deps.render();
  }

  render(width: number): string[] {
    const total = this.detail?.queue.tasks.length ?? 0;
    const text = ["排队输入",
      this.screen === "root" ? (total ? `共 ${total} 项（顺序为持久执行序；选择一项上移/下移或转为引导）。` : "当前没有排队输入。") : `已选择 ${this.selected?.slice(0, 10) ?? ""}`,
      this.message, !this.deps.online() ? "连接已断开；恢复在线后刷新。" : "",
      "Esc 返回 · r 刷新 · q 关闭"].filter(Boolean).join("\n");
    return [...new Text(sanitizeForDisplay(text), 0, 0).render(width), ...(this.list?.render(width) ?? [])];
  }
}
