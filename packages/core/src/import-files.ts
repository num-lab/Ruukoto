/** 导入与工作区迁移共用的文件状态和修订计算。 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { Session } from "./types.ts";

// ---------- 规范化与哈希 ----------

/** 规范化 JSON：对象键递归排序（数组保序），同一语义内容产出同一字符串。 */
export function canonicalJson(value: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortValue((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sortValue(value));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 历史文件状态：缺失/未落盘/损坏单独报告，不显示为「没有历史」（空文件是 ok）。
 * 校验样本内每一条完整 JSONL 行——样本上限 64 KiB，截断的最后一段（未读满的
 * 尾部行）按不完整处理不作损坏判定，之后的行无法核实（样本外不做静默结论）。 */
export function historyStatusOf(session: Session): { history: "ok" | "not_flushed" | "missing" | "unreadable"; reason: string | null } {
  if (session.sessionFile === null) {
    return { history: "not_flushed", reason: "历史尚未落盘：未登记会话文件" };
  }
  let fd: number;
  try {
    fd = fs.openSync(session.sessionFile, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { history: "missing", reason: `登记的会话文件缺失：${session.sessionFile}` };
    }
    return { history: "unreadable", reason: `会话文件不可读：${session.sessionFile}（${(err as Error).message}）` };
  }
  try {
    const fileSize = fs.fstatSync(fd).size;
    const sample = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, sample, 0, sample.length, 0);
    if (bytes === 0) return { history: "ok", reason: null };
    const text = sample.subarray(0, bytes).toString("utf8");
    const lines = text.split("\n");
    // 样本未覆盖整个文件且结尾没有换行：最后一段是截断行（读满的末行仍判定）
    if (bytes < fileSize && !text.endsWith("\n")) lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "") continue; // 空行（如末尾换行后的串尾）不算条目
      try {
        JSON.parse(line);
      } catch {
        return { history: "unreadable", reason: `会话文件已损坏（第 ${i + 1} 行不是合法 JSONL）：${session.sessionFile}` };
      }
    }
    return { history: "ok", reason: null };
  } catch (err) {
    return { history: "unreadable", reason: `会话文件不可读：${session.sessionFile}（${(err as Error).message}）` };
  } finally {
    fs.closeSync(fd);
  }
}
