/**
 * 测试公共设施：隔离的 agentDir / 会话目录、models.json 生成、会话文件读取。
 *
 * 每个测试用独立临时目录，不读取用户真实 ~/.pi/agent（避免用户配置、扩展、
 * 凭据影响验证结果），结束后整体删除。
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export interface TestDirs {
  root: string;
  agentDir: string;
  cwd: string;
  sessionDir: string;
}

export async function makeTestDirs(prefix: string): Promise<TestDirs> {
  const root = await mkdtemp(path.join(tmpdir(), `pi-verify-${prefix}-`));
  const dirs = {
    root,
    agentDir: path.join(root, "agent"),
    cwd: path.join(root, "project"),
    sessionDir: path.join(root, "sessions"),
  };
  await mkdir(dirs.agentDir, { recursive: true });
  await mkdir(dirs.cwd, { recursive: true });
  await mkdir(dirs.sessionDir, { recursive: true });
  return dirs;
}

export async function cleanupDirs(dirs: TestDirs): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true });
}

/**
 * 写出 models.json：自定义 provider 指向本地 mock 服务。
 * contextWindow 刻意调小，使"启用自动压缩"的场景必然触发阈值。
 */
export async function writeModelsJson(dirs: TestDirs, baseUrl: string, contextWindow: number): Promise<void> {
  const models = {
    providers: {
      mock: {
        name: "Mock",
        baseUrl,
        apiKey: "mock-key",
        api: "openai-completions",
        models: [
          {
            id: "mock-model",
            name: "Mock Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens: 1024,
            compat: { supportsUsageInStreaming: true },
          },
        ],
      },
    },
  };
  await writeFile(path.join(dirs.agentDir, "models.json"), JSON.stringify(models, null, 2));
}

export interface SessionLine {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 读取 JSONL 会话文件并解析为对象数组（含 header 行）。 */
export async function readSessionFile(file: string): Promise<SessionLine[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SessionLine);
}

/** 找到目录下唯一的会话文件（测试约定：每个场景一个会话）。 */
export async function findSessionFile(sessionDir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  await walk(sessionDir);
  if (files.length !== 1) throw new Error(`期望 1 个会话文件，实际 ${files.length}: ${files.join(", ")}`);
  return files[0];
}

/** 等待某个条件成立（轮询），超时抛错。用于异步事件流断言。 */
export async function waitFor(desc: string, fn: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${desc}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
