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
import { createHash } from "node:crypto";
import type { Artifact, ImageMimeType } from "@ruukoto/core/types.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { randomId } from "@ruukoto/core/types.ts";

export class ArtifactWriteError extends Error {}

/** 只识别 JPEG、PNG、WebP 的实际文件签名；声明的 image/* 不作为内容证据。 */
export function imageMime(bytes: Buffer): ImageMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

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
      if (this.store.getArtifact(artifactId)?.mimeType) throw new Error("图片产物不可修改");
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

  /** 定稿文件先原子出现，再由调用方与入站/任务归属共同登记元数据。 */
  importImage(input: { id: string; taskId: string; sessionId: string; name: string; mimeType: ImageMimeType; contentHash: string; byteCount: number }, bytes: Buffer): Artifact {
    if (bytes.length !== input.byteCount || imageMime(bytes) !== input.mimeType || createHash("sha256").update(bytes).digest("hex") !== input.contentHash) {
      throw new ArtifactWriteError("图片产物内容校验失败");
    }
    const target = this.fileFor(input.id);
    const temporary = `${target}.${randomId("tmp")}`;
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      try { fs.linkSync(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = this.readImageFile(input.id);
        if (createHash("sha256").update(existing).digest("hex") !== input.contentHash) throw new Error("图片产物文件冲突");
      }
      return this.store.createImageArtifact(input);
    } catch (error) {
      throw new ArtifactWriteError(`图片产物提升失败：${(error as Error).message}`);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private readImageFile(artifactId: string): Buffer {
    const fd = fs.openSync(this.fileFor(artifactId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("图片产物大小或文件类型不合法");
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  }

  /** 模型发送前恢复视觉块，历史只保存引用；每次核实归属、MIME、大小与哈希。 */
  readImage(artifactId: string, owner: { taskId?: string; sessionId?: string } = {}): { type: "image"; mimeType: ImageMimeType; data: string } {
    try {
      const artifact = this.store.getArtifact(artifactId);
      if (!artifact || artifact.status !== "complete" || !artifact.mimeType || !artifact.contentHash ||
        (owner.taskId !== undefined && artifact.taskId !== owner.taskId) ||
        (owner.sessionId !== undefined && artifact.sessionId !== owner.sessionId)) throw new Error("图片产物归属或元数据不合法");
      const bytes = this.readImageFile(artifactId);
      if (bytes.length !== artifact.byteCount || imageMime(bytes) !== artifact.mimeType || createHash("sha256").update(bytes).digest("hex") !== artifact.contentHash) throw new Error("图片产物内容校验失败");
      return { type: "image", mimeType: artifact.mimeType, data: bytes.toString("base64") };
    } catch {
      throw new ArtifactReadError(`图片产物不可读或校验失败：${artifactId}`);
    }
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
