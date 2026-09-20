/**
 * 工具正文产物：在上游工具截断之前捕获的完整正文。
 *
 * - 捕获路径：工作进程的 BashOperations.onData / 文件 Operations 包装器把
 *   原始字节发回后台，这里先落受保护的任务产物文件，再交给上游生成限长
 *   模型视图——避免先在工具里丢弃内容再声称全量留存；
 * - 元数据（归属、字节数、partial/complete）在 SQLite；正文在产物文件，
 *   跨后台重启可按 id 查询；上游 OutputAccumulator 的临时文件不作为存储；
 * - 磁盘写入失败时停止捕获并保留已捕获部分与失败原因，不继续丢弃输出后
 *   报告完整成功。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Artifact } from "../core/types.ts";
import type { Store } from "../core/store.ts";
import { randomId } from "../core/types.ts";

export class ArtifactWriteError extends Error {}

/** 产物正文不可读（元数据存在但文件缺失/损坏）：明确错误，不伪装成空内容。 */
export class ArtifactReadError extends Error {
  readonly code = "artifact_unavailable";
  constructor(message: string) {
    super(message);
  }
}

export class ArtifactStore {
  private readonly root: string;

  constructor(
    private readonly dataDir: string,
    private readonly store: Store,
  ) {
    this.root = path.join(dataDir, "artifacts");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private fileFor(artifactId: string): string {
    return path.join(this.root, `${artifactId}.bin`);
  }

  /** 开始一个产物（SQLite 登记 partial；正文文件随首个数据块创建）。 */
  begin(input: { taskId: string; sessionId: string; name: string }): Artifact {
    const artifact = this.store.createArtifact({ id: randomId("art"), ...input });
    return artifact;
  }

  /** 追加原始字节。失败抛 ArtifactWriteError（调用方据此停止执行）。 */
  append(artifactId: string, chunk: Buffer): void {
    try {
      if (chunk.length === 0) return;
      fs.appendFileSync(this.fileFor(artifactId), chunk);
      this.store.addArtifactBytes(artifactId, chunk.length);
    } catch (err) {
      throw new ArtifactWriteError(`产物写入失败（已保留部分数据）：${(err as Error).message}`);
    }
  }

  /** 结果回收后定稿；中断/写入失败等场景保持 partial。 */
  complete(artifactId: string): void {
    this.store.setArtifactStatus(artifactId, "complete");
  }

  /**
   * 读取产物正文片段（offset/length 字节；跨重启可查）。
   * 按偏移读取，不把整个大文件加载进内存后切片。
   */
  read(artifactId: string, offset = 0, length = 256 * 1024): Buffer {
    const file = this.fileFor(artifactId);
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch (err) {
      throw new ArtifactReadError(`产物正文不可读：${artifactId}（${(err as Error).message}）`);
    }
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.min(Math.max(0, offset), size);
      const len = Math.min(Math.max(0, length), size - start);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  byteLength(artifactId: string): number {
    try {
      return fs.statSync(this.fileFor(artifactId)).size;
    } catch {
      return 0;
    }
  }
}
