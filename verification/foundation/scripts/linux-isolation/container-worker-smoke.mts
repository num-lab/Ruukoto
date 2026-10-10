/**
 * 容器执行边界冒烟（issue 03 §1/§3）：经应用自身的容器启动器与工具工作
 * 进程宿主，验证真实路由——构建镜像 → 容器启动 → bash 工具 → 网络/宿主
 * 路径拒绝 → 整容器回收核实。工作区与授予路径按宿主原路径挂载（issue 28）。
 *
 * 运行前提：docker 可用且已构建 ruukoto-worker 镜像（deploy/worker-image/build.sh）。
 * 用法：npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts
 * 退出码：0 全部通过；1 存在不一致；2 基础设施缺失（镜像/引擎，不是通过）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createContainerLauncher, DEFAULT_CONTAINER_CONFIG } from "../../../../packages/agent/src/execution/launchers.ts";
import { ToolWorkerHost } from "../../../../packages/agent/src/tool-worker/host.ts";

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

async function tool(
  host: ToolWorkerHost,
  opId: string,
  name: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await host.call({ opId, sdkCallId: opId, name, params, timeoutMs: 30_000 });
  const text = (result.content as Array<{ type?: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
  return { text, isError: result.isError };
}

function bash(host: ToolWorkerHost, opId: string, command: string): Promise<{ text: string; isError: boolean }> {
  return tool(host, opId, "bash", { command });
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
  // 只读授予路径（工作区外）
  const grantedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-smoke-granted-")));
  const grantedFile = path.join(grantedDir, "granted.txt");
  fs.writeFileSync(grantedFile, "granted-value\n", "utf8");

  const launcher = createContainerLauncher(DEFAULT_CONTAINER_CONFIG);
  const host = await ToolWorkerHost.start(launcher, {
    taskId: "smoke",
    mode: "confirm",
    workspace,
    grantedPaths: [{ path: grantedDir, access: "read", purpose: "smoke" }],
  });

  const hbPath = path.join(workspace, "heartbeat.txt");
  const countBeats = () => {
    try {
      return fs.readFileSync(hbPath, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  // 心跳间隔 1s：窗口须覆盖 ≥2 个完整周期并留调度余量
  const BEAT_WINDOW_MS = 3200;
  const beatsAfter = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    return countBeats();
  };

  try {
    // 1. 工具在容器内执行：可见工作区、可写工作区，结果回传宿主
    const r1 = await bash(host, "smoke-1", "echo container-ok && touch made-in-container.txt && id -u");
    check("容器内 bash 工具执行", /container-ok/.test(r1.text) && !r1.isError, r1.text.trim().split("\n")[0] ?? "");
    const uidLine = r1.text.match(/^\d+$/m)?.[0] ?? "?";
    check("非 root 身份", uidLine === String(DEFAULT_CONTAINER_CONFIG.uid) && DEFAULT_CONTAINER_CONFIG.uid !== 0, `id -u=${uidLine}`);
    check("工作区写入对宿主可见", fs.existsSync(path.join(workspace, "made-in-container.txt")), "made-in-container.txt");

    // 2. 网络默认关闭（直接与间接都不可达）
    const r2 = await bash(
      host,
      "smoke-2",
      `node -e "const s=require('net').connect(443,'1.1.1.1');s.setTimeout(2000,()=>{console.log('NETERR timeout');process.exit(0)});s.on('error',e=>console.log('NETERR',e.code));s.on('connect',()=>{console.log('NET-CONNECTED');s.end()})"`,
    );
    check("容器无外网出口", /NETERR/.test(r2.text) && !/NET-CONNECTED/.test(r2.text), r2.text.trim().slice(0, 120));

    // 3. 宿主工作区外的真实文件不可见（文件真实存在；并断言拒绝形态是"路径不存在"——
    //    未挂载的边界，而不是权限或其他表象）
    const r3 = await bash(host, "smoke-3", `cat ${JSON.stringify(secretPath)} /etc/ruukoto-backend 2>&1 | head -2`);
    check(
      "工作区外宿主文件不可见（未挂载而非权限拒绝）",
      !r3.text.includes("host-secret-value") && /No such file|not found/i.test(r3.text),
      r3.text.trim().slice(0, 120),
    );

    // 4. 基础文件系统只读，能力已移除
    const r4 = await bash(host, "smoke-4", "touch /etc/escape 2>&1; grep CapEff /proc/self/status");
    check("容器基础文件系统只读", /Permission denied|Read-only file system/.test(r4.text), r4.text.trim().split("\n")[0] ?? "");
    check("容器无有效 capabilities", /CapEff:\s+0{16}/.test(r4.text), r4.text.match(/CapEff:.*/)?.[0] ?? "?");

    // 5. 子进程不能绕过边界取到执行单元之外的生命周期：脱离会话的孙进程
    //    （忽略 SIGHUP、与发起 shell 分离、挂到容器 pid1 下）在执行单元活着
    //    时真实运行，单元回收后必须随之终止（不能只终止工作进程本身）。
    //    sleep 120 是无写动作的另一个逃逸常驻进程，同样只能随容器消亡。
    const rSpawn = await bash(
      host,
      "smoke-9",
      "nohup sh -c 'while true; do echo beat >> heartbeat.txt; sleep 1; done' >/dev/null 2>&1 & nohup sleep 120 >/dev/null 2>&1 & echo spawned",
    );
    check("逃逸孙进程发起成功", !rSpawn.isError && /spawned/.test(rSpawn.text), rSpawn.text.trim().slice(0, 80));
    const before = countBeats();
    const later = await beatsAfter(BEAT_WINDOW_MS);
    check("逃逸孙进程实际在运行（对照）", later >= before + 2, `心跳 ${before} → ${later}`);

    // 6. 按宿主原路径挂载：工作目录、绝对路径读取与只读授予路径在容器内外一致
    const r5 = await bash(host, "smoke-5", "pwd");
    check("bash 工作目录为宿主工作区路径", r5.text.trim() === workspace && !r5.isError, r5.text.trim());
    const r6 = await tool(host, "smoke-6", "read", { path: path.join(workspace, "seed.txt") });
    check("按宿主绝对路径读取工作区文件", /seed/.test(r6.text) && !r6.isError, r6.text.trim().slice(0, 120));
    const r7 = await bash(host, "smoke-7", `cat ${JSON.stringify(grantedFile)}`);
    check("只读授予路径在宿主路径下可读", /granted-value/.test(r7.text) && !r7.isError, r7.text.trim());
    const escape = path.join(grantedDir, "escape.txt");
    const r8 = await bash(host, "smoke-8", `touch ${JSON.stringify(escape)} 2>&1`);
    check(
      "只读授予路径不可写",
      /Read-only file system/.test(r8.text) && !fs.existsSync(escape),
      r8.text.match(/.*Read-only file system.*/)?.[0] ?? r8.text.trim().slice(0, 120),
    );
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
    // 停止确认后心跳必须冻结：若仍有写入（或心跳文件被删掉），说明孙进程逃出了
    // 被回收的执行单元。文件须在停止后仍然存在——逃逸者删除文件也会造成 0→0 的假通过。
    const frozen = countBeats();
    const afterStop = await beatsAfter(BEAT_WINDOW_MS);
    check(
      "停止操作回收逃逸孙进程（心跳冻结且载体仍存在）",
      reaped && fs.existsSync(hbPath) && afterStop === frozen,
      `心跳 ${frozen} → ${afterStop}，文件存在=${fs.existsSync(hbPath)}`,
    );
  }

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
  fs.rmSync(grantedDir, { recursive: true, force: true });
  console.log(failures === 0 ? "== 容器边界冒烟全部通过 ==" : `== ${failures} 项不一致 ==`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
