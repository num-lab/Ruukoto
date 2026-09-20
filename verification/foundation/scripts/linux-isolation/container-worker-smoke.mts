/**
 * 容器执行边界冒烟（issue 03 §1/§3）：经应用自身的容器启动器与工具工作
 * 进程宿主，验证真实路由——构建镜像 → 容器启动 → bash 工具 → 网络/宿主
 * 路径拒绝 → 整容器回收核实。
 *
 * 运行前提：docker 可用且已构建 ruukoto-worker 镜像（deploy/worker-image/build.sh）。
 * 用法：npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts
 * 退出码：0 全部通过；1 存在不一致；2 基础设施缺失（镜像/引擎，不是通过）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createContainerLauncher, DEFAULT_CONTAINER_CONFIG } from "../../../../src/agent/execution/launchers.ts";
import { ToolWorkerHost } from "../../../../src/agent/tool-worker/host.ts";

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "OK " : "!!!"} ${name} —— ${detail}`);
  if (!cond) failures++;
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function imageExists(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function bash(host: ToolWorkerHost, opId: string, command: string): Promise<{ text: string; isError: boolean }> {
  const result = await host.call({
    opId,
    sdkCallId: opId,
    name: "bash",
    params: { command },
    timeoutMs: 30_000,
  });
  const text = (result.content as Array<{ type?: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
  return { text, isError: result.isError };
}

async function main(): Promise<number> {
  if (!dockerAvailable()) {
    console.error("基础设施缺失：docker 引擎不可用（退出码 2，不计为边界通过）");
    return 2;
  }
  const image = process.env.RUUKOTO_WORKER_IMAGE ?? DEFAULT_CONTAINER_CONFIG.image;
  if (!imageExists(image)) {
    console.error(`基础设施缺失：镜像 ${image} 不存在，先运行 deploy/worker-image/build.sh（退出码 2）`);
    return 2;
  }

  // 工作区与"工作区外的宿主秘密文件"（后者不挂载）
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-smoke-ws-")));
  const secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-smoke-secret-")));
  const secretPath = path.join(secretDir, "host-secret.txt");
  fs.writeFileSync(secretPath, "host-secret-value\n", "utf8");
  fs.writeFileSync(path.join(workspace, "seed.txt"), "seed\n", "utf8");

  const launcher = createContainerLauncher(DEFAULT_CONTAINER_CONFIG);
  const host = await ToolWorkerHost.start(launcher, {
    taskId: "smoke",
    mode: "confirm",
    workspace,
    grantedPaths: [],
  });

  try {
    // 1. 工具在容器内执行：可见工作区、可写工作区，结果回传宿主
    const r1 = await bash(host, "smoke-1", "echo container-ok && touch made-in-container.txt && id -u");
    check("容器内 bash 工具执行", /container-ok/.test(r1.text) && !r1.isError, r1.text.trim().split("\n")[0] ?? "");
    check("非 root 身份", /\b1000\b/.test(r1.text), `id -u=${r1.text.match(/^\d+$/m)?.[0] ?? "?"}`);
    check("工作区写入对宿主可见", fs.existsSync(path.join(workspace, "made-in-container.txt")), "made-in-container.txt");

    // 2. 网络默认关闭（直接与间接都不可达）
    const r2 = await bash(
      host,
      "smoke-2",
      `node -e "const s=require('net').connect(443,'1.1.1.1');s.setTimeout(2000,()=>{console.log('NETERR timeout');process.exit(0)});s.on('error',e=>console.log('NETERR',e.code));s.on('connect',()=>{console.log('NET-CONNECTED');s.end()})"`,
    );
    check("容器无外网出口", /NETERR/.test(r2.text) && !/NET-CONNECTED/.test(r2.text), r2.text.trim().slice(0, 120));

    // 3. 宿主工作区外的真实文件不可见（文件真实存在，拒绝原因是边界而非目标不存在）
    const r3 = await bash(host, "smoke-3", `cat ${JSON.stringify(secretPath)} /etc/ruukoto-backend 2>&1 | head -2`);
    check(
      "工作区外宿主文件不可见",
      !r3.text.includes("host-secret-value"),
      r3.text.trim().slice(0, 120),
    );

    // 4. 基础文件系统只读，能力已移除
    const r4 = await bash(host, "smoke-4", "touch /etc/escape 2>&1; grep CapEff /proc/self/status");
    check("容器基础文件系统只读", /Permission denied|Read-only file system/.test(r4.text), r4.text.trim().split("\n")[0] ?? "");
    check("容器无有效 capabilities", /CapEff:\s+0{16}/.test(r4.text), r4.text.match(/CapEff:.*/)?.[0] ?? "?");
  } finally {
    const identity = host.identity();
    const reaped = await host.stop();
    check("停止并核实执行单元已退出", reaped, `unit=${identity.id}`);
    let inspectFails = false;
    try {
      execFileSync("docker", ["inspect", identity.id], { stdio: "ignore" });
    } catch {
      inspectFails = true;
    }
    check("容器已移除（不遗留执行单元）", inspectFails, identity.id);
  }

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
  console.log(failures === 0 ? "== 容器边界冒烟全部通过 ==" : `== ${failures} 项不一致 ==`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
