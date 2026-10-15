export function workflowStatus(status: string): string {
  return ({ queued: "○ 排队", running: "▶ 运行中", waiting: "? 待回答/审批", paused: "Ⅱ 已暂停", succeeded: "✓ 成功", partial: "! 部分失败", failed: "× 失败", canceled: "■ 已取消" } as Record<string, string>)[status] ?? status;
}
