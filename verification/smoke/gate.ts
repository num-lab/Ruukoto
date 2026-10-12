import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createLauncherFor, ExecutionError, type LaunchedUnit, type WorkerLauncher } from "@ruukoto/agent/execution/launchers.ts";
import { linuxNativeScopeEmpty } from "@ruukoto/agent/execution/native-linux.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";

export function prerequisite(message: string): never {
  process.stderr.write(`[ruukoto:smoke] 前提缺失：${message}\n`);
  process.exit(2);
}

export function requireNoArgs(): void {
  if (process.argv.length > 2) prerequisite(`此入口不接受参数：${process.argv.slice(2).join(" ")}；请在当前检出目录本地运行`);
}

/** 真正启动 worker；创建过执行单元的失败也必须核实停止后才清理。 */
export async function probeNativeExecution(launcher: WorkerLauncher, root: string): Promise<void> {
  const identity = fs.statSync(root);
  const host = ToolWorkerHost.create(launcher, { taskId: "smoke-prerequisite", mode: "confirm",
    workspace: root, workspaceIdentity: { dev: identity.dev, ino: identity.ino }, grantedPaths: [] });
  let failure: unknown = null;
  try { await host.start(); }
  catch (error) { failure = error; }
  if (!await host.stop()) throw new Error(`原生前提检查停止未核实；保留现场 ${root}；见 deploy/native/README.md`, { cause: host.stopFailure ?? failure });
  fs.rmSync(root, { recursive: true, force: true });
  if (failure) throw failure;
}

export async function requireNative(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "ruukoto-native-gate-")));
  try { await probeNativeExecution(createLauncherFor({ backend: "native" }, "confirm"), root); }
  catch (error) {
    if (error instanceof ExecutionError && error.code === "execution_unavailable") {
      prerequisite(`原生执行不可用：${error.message}；先运行 npm run build 并检查 deploy/native/README.md`);
    }
    process.stderr.write(`[ruukoto:smoke] FAIL 原生前提检查：${String(error)}\n`);
    process.exit(1);
  }
}

export interface RecordedUnit {
  taskId: string;
  unit: LaunchedUnit;
  cgroup: string | null;
  stopped: boolean | null;
}

/** 只记录本次真实 launcher 的单元，不改变授权或平台停止判定。 */
export function recordRuntimeUnits(runtime: Runtime, units: RecordedUnit[] = []): RecordedUnit[] {
  const launcherFor = runtime.launcherFor.bind(runtime);
  runtime.launcherFor = mode => {
    const launcher = launcherFor(mode);
    return { kind: launcher.kind, launch: async spec => {
      let unit: LaunchedUnit;
      try { unit = await launcher.launch(spec); }
      catch (error) {
        if (error instanceof ExecutionError && error.unit) {
          const partial = error.unit;
          const record: RecordedUnit = { taskId: spec.taskId, unit: partial, cgroup: null, stopped: null };
          units.push(record);
          const stop = partial.entry.stop;
          partial.entry.stop = async () => record.stopped = await stop();
        }
        throw error;
      }
      const record: RecordedUnit = { taskId: spec.taskId, unit, cgroup: null, stopped: null };
      units.push(record);
      const stop = unit.entry.stop;
      unit.entry.stop = async () => record.stopped = await stop();
      if (unit.entry.kind === "systemd_unit" && process.platform === "linux") {
        let group: string;
        try { group = execFileSync("/usr/bin/systemctl", ["--user", "show", unit.entry.id, "--property", "ControlGroup", "--value"],
          { encoding: "utf8", timeout: 5000 }).trim();
        assert.ok(path.isAbsolute(group) && path.normalize(group) === group && path.basename(group) === unit.entry.id, "本次 scope 路径须匹配已启动身份");
        record.cgroup = path.join("/sys/fs/cgroup", group);
        } catch (error) { throw new ExecutionError("smoke_unit_unverified", `scope 身份核实失败：${String(error)}`, unit); }
      }
      return unit;
    } };
  };
  return units;
}

export async function assertUnitsStopped(units: RecordedUnit[], taskId?: string, requireWorker = true): Promise<void> {
  const selected = taskId === undefined ? units : units.filter(record => record.taskId === taskId);
  if (requireWorker) assert.ok(selected.length > 0, "本次任务须真实创建过工具执行单元");
  for (const record of selected) {
    assert.equal(record.stopped, true, `单元 ${record.unit.entry.id} 停止须已经核实`);
    assert.equal(await record.unit.entry.stop(), true, "重复核实保留同一停止结论");
    if (record.cgroup !== null) assert.equal(linuxNativeScopeEmpty(record.cgroup), true, "已观察的 cgroup 须为空或确实消失");
  }
}

export async function cleanupRuntime(
  runtime: { stop(reason: string): Promise<void> },
  model: { close(): Promise<void> },
  directory: string,
  units: RecordedUnit[] = [],
): Promise<Error | null> {
  let failure: Error | null = null;
  try { await runtime.stop("smoke_end"); }
  catch (cause) { failure = new Error("Runtime 停止失败", { cause }); }
  try { await model.close(); }
  catch (cause) { failure ??= new Error("模型桩关闭失败", { cause }); }
  try { await assertUnitsStopped(units, undefined, false); }
  catch (cause) { failure ??= new Error("工具单元停止未核实", { cause }); }
  if (failure) return failure;
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch (cause) { return new Error("临时目录清理失败", { cause }); }
  return null;
}
