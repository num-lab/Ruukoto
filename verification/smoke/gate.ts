import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

export function prerequisite(message: string): never {
  console.error(`前提缺失：${message}`);
  process.exit(2);
}

export function requireNoArgs(): void {
  if (process.argv.length > 2) prerequisite(`此入口不接受参数：${process.argv.slice(2).join(" ")}；请在当前检出目录本地运行`);
}

export function requireDocker(image: string): void {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore", timeout: 15_000 });
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 30_000 });
  } catch {
    prerequisite(`需要可用的 Docker 与镜像 ${image}；先运行 npm run build:worker-image`);
  }
}

export async function cleanupRuntime(
  runtime: { stop(reason: string): Promise<void> },
  model: { close(): Promise<void> },
  directory: string,
): Promise<Error | null> {
  let failure: Error | null = null;
  try { await runtime.stop("smoke_end"); }
  catch (cause) { failure = new Error("Runtime 停止失败", { cause }); }
  try { await model.close(); }
  catch (cause) { failure ??= new Error("模型桩关闭失败", { cause }); }
  if (failure) return failure;
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch (cause) { return new Error("临时目录清理失败", { cause }); }
  return null;
}
