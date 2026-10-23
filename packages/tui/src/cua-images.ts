import type { ControlClient } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportArtifact } from "./artifact-export.ts";

class CuaImageViewError extends Error {
  readonly code = "cua_image_view_failed";
}

/** 用户选择查看后才打开系统图片查看器；返回只表示交付查看器，接受仍需本人确认。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
export async function showCuaImages(client: ControlClient, status: OpResult<"mcp_cua_status">): Promise<void> {
  if (!status.original || !status.observation?.artifactIds.length) throw new CuaImageViewError("没有可查看的新截图；请重新读取电脑恢复状态。");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-cua-view-"));
  fs.chmodSync(directory, 0o700);
  for (const [index, id] of status.observation.artifactIds.entries()) {
    const temporary = path.join(directory, `image-${index}`);
    const artifact = await exportArtifact(client, status.original.taskId, id, temporary);
    const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
    const extension = extensions[artifact.mimeType ?? ""];
    if (!extension) throw new CuaImageViewError("恢复图片格式无法核实；请保留原记录并重新观察。");
    const filename = temporary + extension;
    fs.renameSync(temporary, filename);
    await new Promise<void>((resolve, reject) => execFile(process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open", [filename], { timeout: 10_000, maxBuffer: 4096 }, error => error ? reject(new CuaImageViewError("无法打开恢复图片；请检查系统图片查看器，未接受该观察。")) : resolve()));
  }
  const current = await client.request<OpResult<"mcp_cua_status">>("mcp_cua_status", {});
  if (current.observation?.id !== status.observation.id) throw new CuaImageViewError("恢复观察已经改变；请重新查看最新截图后再接受。");
}
