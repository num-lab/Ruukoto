/**
 * 待确认请求记录（拥有者私有目录）：输入提交的去重锚点。
 *
 * 纪律（issue 04 §3）：
 * - 发送前先生成 request_id 并把操作类型与完整请求参数原子落盘
 *   （临时文件 + rename，0600）；写入失败时不得发送请求；
 * - 后台确认接收（应答返回任务 ID）后清除记录；
 * - 记录绑定数据实例标识：后台重启保留标识可继续核实；新数据库分配新
 *   标识，此时保留待核实输入并要求拥有者处理，不向空后台重发；
 * - 记录只代表"尚未确认接收"的请求，不作为会话历史副本；令牌等凭据
 *   永远不写入这里。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dirEnvFor, productFromEnv, productRootDir } from "@ruukoto/core/product.ts";

export interface PendingRequest {
  requestId: string;
  op: "submit" | "continue";
  /** 完整请求参数（session_id/task_id、input、access_mode、granted_paths）。 */
  params: Record<string, unknown>;
  /** 提交时握手返回的数据实例标识。 */
  instanceId: string;
  createdAt: string;
}

export interface PendingRequestList {
  records: PendingRequest[];
  /** 无法解析的记录文件名（保留在磁盘上，需人工处理）。 */
  corrupt: string[];
}

export function defaultPendingDir(): string {
  const product = productFromEnv();
  return dirEnvFor(product, "PENDING") ?? path.join(productRootDir(product), "pending");
}

export class PendingRequestStore {
  readonly dir: string;

  constructor(dir: string = defaultPendingDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private fileFor(requestId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
      throw new Error(`request_id 含非法字符：${requestId}`);
    }
    return path.join(this.dir, `${requestId}.json`);
  }

  /** 原子保存（先写临时文件再 rename）；抛错时调用方不得发送请求。 */
  save(record: PendingRequest): void {
    const file = this.fileFor(record.requestId);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** 后台已确认接收：清除记录（幂等）。 */
  clear(requestId: string): void {
    try {
      fs.rmSync(this.fileFor(requestId), { force: true });
    } catch {
      // 清除失败不阻断流程；下次核实会再次关联并清除
    }
  }

  /** 全部待确认记录；损坏文件保留并单独列出（不静默丢弃）。 */
  list(): PendingRequestList {
    const records: PendingRequest[] = [];
    const corrupt: string[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return { records, corrupt };
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as PendingRequest;
        if (
          typeof raw?.requestId !== "string" ||
          (raw.op !== "submit" && raw.op !== "continue") ||
          typeof raw.params !== "object" ||
          raw.params === null ||
          typeof raw.instanceId !== "string"
        ) {
          corrupt.push(file);
          continue;
        }
        records.push(raw);
      } catch {
        corrupt.push(file);
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { records, corrupt };
  }
}
