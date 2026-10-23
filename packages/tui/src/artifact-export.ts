import type { ControlClient } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { imageMime } from "@ruukoto/agent/artifacts.ts";
import { randomId, type Artifact } from "@ruukoto/core/types.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

// Note: 见 .agents/notes/implemented/feature/2026-10-14-artifact-file-export.md
export async function exportArtifact(client: ControlClient, taskId: string, artifactId: string, output: string): Promise<Artifact> {
  const pageSize = 720 * 1024;
  const params = { task_id: taskId, artifact_id: artifactId, length: pageSize };
  let page = await client.request<OpResult<"read_artifact">>("read_artifact", { ...params, offset: 0 });
  const artifact = page.artifact;
  if (artifact.id !== artifactId || artifact.taskId !== taskId || !Number.isSafeInteger(artifact.byteCount) || artifact.byteCount < 0) {
    throw new Error("产物元数据不合法，请核实产物归属与字节数");
  }
  if (artifact.status !== "complete") throw new Error("产物尚未完整定稿，不能完整导出；可用 --offset / --length 查看已捕获部分");
  if (artifact.mimeType && !/^[a-f0-9]{64}$/.test(artifact.contentHash ?? "")) throw new Error("图片产物缺少有效 SHA-256，不能完整导出");
  const destination = path.resolve(output);
  const temporary = path.join(path.dirname(destination), `.ruukoto-artifact-${randomId("tmp")}`);
  const hash = artifact.contentHash ? createHash("sha256") : null;
  let fd: number | undefined = fs.openSync(temporary, "wx", 0o600);
  let renamed = false;
  try {
    let offset = 0;
    for (;;) {
      if (!isDeepStrictEqual(page.artifact, artifact)) throw new Error("下载期间产物元数据变化，请重新核实产物");
      const bytes = Buffer.from(page.data, "base64");
      if (page.encoding !== "base64" || bytes.toString("base64") !== page.data || bytes.length !== Math.min(pageSize, artifact.byteCount - offset)) {
        throw new Error("产物分页不完整或编码不合法，请核实产物正文");
      }
      if (offset === 0 && artifact.mimeType && imageMime(bytes) !== artifact.mimeType) throw new Error("图片产物 MIME 与正文不符，请核实原图");
      fs.writeFileSync(fd, bytes);
      hash?.update(bytes);
      offset += bytes.length;
      if (offset === artifact.byteCount) break;
      page = await client.request<OpResult<"read_artifact">>("read_artifact", { ...params, offset });
    }
    if (fs.fstatSync(fd).size !== artifact.byteCount || (hash && hash.digest("hex") !== artifact.contentHash)) {
      throw new Error("产物总字节数或 SHA-256 不一致，请核实产物正文");
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
    renamed = true;
    return artifact;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!renamed) fs.rmSync(temporary, { force: true });
  }
}
