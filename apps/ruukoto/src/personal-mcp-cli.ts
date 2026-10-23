import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { discoverCuaTargets } from "@ruukoto/agent/mcp/cua-discovery.ts";
import { restrictCuaTool } from "@ruukoto/agent/mcp/cua.ts";
import { exportPersonalArtifact, type PersonalArtifact } from "./personal-artifacts.ts";
import { executePersonalSettings } from "./personal-settings.ts";
import { PersonalError } from "./personal-error.ts";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskId } from "@earendil-works/pi-durable";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl } from "./personal-control.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { discoverPersonalMcp, migratePersonalMcp, personalMcpCredential, readPersonalMcp, savePersonalMcp, type PersonalMcpService } from "./personal-mcp-config.ts";
import { personalMcpDescription } from "./personal-mcp-controls.ts";
import type { mcpList, mcpDetail } from "./personal-mcp.ts";

export async function configurePersonalMcp(io: PersonalCliIO, directory: string): Promise<void> {
  const profile = lockPersonalProfile(directory);
  try {
    const current = readPersonalMcp(profile);
    const services = current?.services ?? [];
    const choices = ["新增服务", ...services.map(service => service.label), "Linux 桌面沙箱", ...(current?.version === 1 ? ["迁入服务启停配置"] : []), "返回"];
    const selected = await choose(io, "个人 MCP 服务", choices);
    if (selected === choices.length - 1) return;
    if (current?.version === 1 && selected === services.length + 2) {
      if (await choose(io, "迁入后保留原工具与历史，旧程序不能再打开此 MCP 配置", ["返回", "确认迁入服务启停配置"]) === 0) return;
      await migratePersonalMcp(profile);
      io.write("MCP 已迁入服务启停配置；原服务保持启用，旧历史与请求证据保留。\n");
      return;
    }
    const original = selected > 0 && selected <= services.length ? services[selected - 1] : undefined;
    const cuaSelection = selected === services.length + 1 || !!original?.cua;
    const version = current?.version ?? 2;
    if (original) {
      io.write(`\n${original.label}\n入口：${original.cua ? `本地 Linux 沙箱 ${original.cua.sandbox}` : original.endpoint}\n认证：${original.cua ? "宿主管理" : original.credential ? "绑定私有令牌文件" : "显式匿名"}\n固定允许工具：${original.tools.map(tool => tool.name).join("、") || "无"}\n`);
      const actions = ["查看固定工具定义", "替换配置并重新选择工具", "移除服务", ...(version !== 1 ? [original.enabled ? "停用服务" : "启用服务"] : []), "返回"];
      const action = await choose(io, "原 MCP 服务", actions);
      if (action === actions.length - 1) return;
      if (action === 0) { io.write(`${JSON.stringify(original.tools, null, 2)}\n`); return; }
      if (action === 3) {
        await savePersonalMcp(profile, { version, generation: randomUUID(), services: services.map(service => service === original ? { ...service, enabled: !service.enabled } : service) });
        io.write(`MCP 服务已${original.enabled ? "停用" : "启用"}；原端点、凭据引用和允许工具保留，请启动后台使配置生效。\n`);
        return;
      }
      if (action === 2) {
        if (await choose(io, "移除后旧工作仍保留原配置与未知效果，不能自动改用其他服务", ["返回", "确认移除服务"]) === 0) return;
        await savePersonalMcp(profile, { version, generation: randomUUID(), services: services.filter(service => service !== original) });
        io.write("MCP 服务已移除；旧工作不会换服务重发，请从操作管理核实未决请求。\n");
        return;
      }
    }
    io.write("先发现服务工具，再逐项选择允许范围；只读标注不提供权限。配置变化后旧工作须复核，不会自动换服务重发。凭据仅绑定私有令牌文件，缺失时不会降级匿名。输入 /back 返回。\n");
    const label = (await io.question("服务名称（便于自己辨认）：")).trim();
    if (label === "/back") return;
    let target: { id: string; label: string; endpoint?: string; cua?: PersonalMcpService["cua"]; credential?: PersonalMcpService["credential"] };
    if (cuaSelection) {
      const result = await discoverCuaTargets("cua-linux");
      for (const issue of result.issues) io.write(`${issue.message}\n`);
      const targets = result.targets.filter(item => item.config.kind === "cua-linux");
      if (!targets.length) { io.write("未发现可用的既有 Linux 桌面沙箱，请按安装说明准备本地环境。\n"); return; }
      const selectedTarget = await choose(io, "选择本地 Linux 桌面沙箱", [...targets.map(item => item.label), "返回"]);
      if (selectedTarget === targets.length) return;
      const config = targets[selectedTarget].config;
      if (config.kind !== "cua-linux") return;
      target = { id: original?.id ?? randomUUID(), label, cua: config };
    } else {
    const endpoint = (await io.question("MCP HTTP 端点（完整 HTTPS URL；本机回环可用 HTTP）：")).trim();
    if (endpoint === "/back") return;
    const authentication = await choose(io, "服务认证", ["绑定私有令牌文件", "明确使用匿名连接", "返回"]);
    if (authentication === 2) return;
    let credential: PersonalMcpService["credential"];
    if (authentication === 0) {
      const filename = (await io.question("私有令牌文件绝对路径（不粘贴令牌，/back 返回）：")).trim();
      if (filename === "/back") return;
      credential = personalMcpCredential(filename);
    }
    target = { id: original?.id ?? randomUUID(), label, endpoint, ...(credential ? { credential } : {}) };
    }
    const discovered = (await discoverPersonalMcp(target)).filter(tool => !target.cua || restrictCuaTool(target.cua, tool));
    const tools: PersonalMcpService["tools"] = [];
    for (const tool of discovered) {
      io.write(`\n服务返回的原工具定义：\n${JSON.stringify(tool, null, 2)}\n`);
      const action = await choose(io, `是否允许工具 ${tool.name}`, ["不加入允许列表", "加入允许列表", "取消本次配置"]);
      if (action === 2) return;
      if (action === 1) tools.push(tool);
    }
    if (target.cua && !tools.some(tool => tool.name === "computer_screenshot")) { io.write("电脑入口必须允许 computer_screenshot 才能观察与恢复，未保存服务。\n"); return; }
    if (!tools.length) { io.write("没有选择允许工具，未保存服务。\n"); return; }
    if (await choose(io, `${label}：固定允许 ${tools.map(tool => tool.name).join("、")}`, ["返回", "保存服务与固定工具"]) === 0) return;
    await savePersonalMcp(profile, { version: target.cua ? 3 : version, generation: randomUUID(), services: [...services.filter(service => service !== original), { ...target, tools, ...(target.cua || version !== 1 ? { enabled: original?.enabled ?? true } : {}) }] });
    io.write("MCP 配置与原工具定义已保存；配置不授予操作权限。请启动后台；旧操作从管理菜单核实，不要换服务重发。\n");
  } finally { profile.release(); }
}

const openLinuxImage = (filename: string) => new Promise<void>((resolve, reject) => execFile("/usr/bin/xdg-open", [filename], { timeout: 15_000, maxBuffer: 4096 }, error => error ? reject(new PersonalError("cua_image_viewer_unavailable", "新截图已导出，但无法打开图片查看器；请在有图形会话的原主机查看，未接受现场。")) : resolve()));
export async function viewPersonalCuaImages(io: PersonalCliIO, directory: string, images: PersonalArtifact[], open = openLinuxImage): Promise<boolean> {
  if (!images.length) return false;
  let viewDirectory: string;
  try { viewDirectory = fs.mkdtempSync(path.join(directory, "artifacts", "cua-view-")); }
  catch (error) { throw new PersonalError("cua_image_export_failed", "恢复截图无法导出，请检查原档案的产物目录；未接受现场。", { cause: error }); }
  for (const image of images) {
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[image.mime];
    if (!extension) throw new PersonalError("cua_image_invalid", "恢复图片类型无法核实，请重新观察。");
    const destination = path.join(viewDirectory, `${image.id}.${extension}`);
    await exportPersonalArtifact(directory, image, destination);
    io.write(`打开恢复新截图：${destination}\n`);
    await open(destination);
  }
  return await choose(io, "请查看全部新截图，核实当前桌面与原业务结果", ["尚未查看，返回", "已查看全部新截图"]) === 1;
}
export async function managePersonalCua(io: PersonalCliIO, directory: string): Promise<void> {
  const initial = await executePersonalSettings(directory, { v: 1, op: "settings.read" }) as { profile: object; revisions: { mcp: string } };
  const base = { v: 1, profile: initial.profile, expectedRevision: initial.revisions.mcp };
  const status = await executePersonalSettings(directory, { ...base, op: "mcp.cua-status" }) as { available: boolean; paused: boolean; busy: boolean; operations: unknown[] };
  if (!status.available) { io.write("原后台尚未装配 Linux 桌面沙箱；请先停止后台并从 MCP 配置选择既有沙箱。\n"); return; }
  io.write(status.paused ? "电脑已暂停。\n" : "电脑已启用。退出向导不会停止后台动作。\n");
  const choices = [status.paused ? "继续电脑（先重新观察）" : "暂停电脑", ...(status.operations.length ? ["核实原未知动作并恢复"] : []), "返回"];
  const selected = await choose(io, "电脑控制", choices);
  if (selected === choices.length - 1) return;
  if (selected === 1) return managePersonalMcp(io, directory);
  await executePersonalSettings(directory, { ...base, op: "mcp.cua-control", action: status.paused ? "resume" : "pause" });
  io.write(status.paused ? "电脑已继续，下一次操作先读取新截图。\n" : status.busy ? "已暂停新调用；请等原调用结束后刷新停止状态。\n" : "电脑已暂停，受管 CLI 已停止。\n");
}

export async function managePersonalMcp(io: PersonalCliIO, directory: string): Promise<void> {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof mcpList>>>(directory, "GET", `/mcp/operations?offset=${offset}`);
    const choices = [...page.items.map(personalMcpDescription), ...(page.nextOffset === undefined ? [] : ["下一页 MCP 操作"]), "返回"];
    const selected = await choose(io, "MCP 原操作", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const operation = page.items[selected].operation as TaskId;
    let detailOffset = 0, viewedObservation: number | undefined;
    while (true) {
      const detail = await personalControl<Awaited<ReturnType<typeof mcpDetail>>>(directory, "GET", `/mcp/operation?operation=${operation}&offset=${detailOffset}`);
      io.write(`\n${personalMcpDescription(detail.summary)}\n原请求、响应与核实证据：\n${detail.text}\n`);

      const actions = ["刷新原操作", ...(detail.nextOffset === undefined ? [] : ["下一页原记录"]), ...(detail.summary.canDecide ? ["批准本次 MCP 操作", "拒绝本次 MCP 操作"] : []), ...(detail.summary.canResolve ? ["确认业务已生效", "确认业务未生效"] : []), ...(detail.summary.canRecheck ? ["核实原请求结束"] : []), ...(detail.summary.cuaRecovery === "frozen" ? ["停止原电脑运行代并保留磁盘"] : detail.summary.cuaRecovery === "stopped" ? ["检查结果并开始恢复"] : detail.summary.cuaRecovery === "begun" ? ["读取恢复新截图"] : detail.summary.cuaRecovery === "observed" ? ["查看恢复新截图", "重新读取恢复截图", ...(viewedObservation === detail.summary.cuaObservation ? ["接受新截图并开放新工作"] : [])] : []), "返回操作列表"];
      const action = actions[await choose(io, "原 MCP 操作", actions)];
      if (action === "返回操作列表") break;
      if (action === "下一页原记录") { detailOffset = detail.nextOffset!; continue; }
      detailOffset = 0;
      if (action === "查看恢复新截图") { viewedObservation = undefined; if (await viewPersonalCuaImages(io, directory, detail.recoveryImages ?? [])) viewedObservation = detail.summary.cuaObservation; continue; }
      const recovery = { "停止原电脑运行代并保留磁盘": "stop", "检查结果并开始恢复": "begin", "读取恢复新截图": "observe", "重新读取恢复截图": "observe", "接受新截图并开放新工作": "accept" } as const;
      if (action in recovery) {
        if (action === "读取恢复新截图" || action === "重新读取恢复截图") viewedObservation = undefined;
        if (action === "停止原电脑运行代并保留磁盘" && await choose(io, "停止整个原沙箱会丢失内存及未保存应用状态，磁盘保留", ["返回", "确认停止原运行代"]) === 0) continue;
        if (action === "检查结果并开始恢复" && await choose(io, "先检查原业务结果；恢复只会开启新观察，原未知动作不会重发", ["返回", "已检查结果，开始恢复"]) === 0) continue;
        await personalControl(directory, "POST", `/mcp/cua-recover?operation=${operation}`, { action: recovery[action as keyof typeof recovery], ...(action === "接受新截图并开放新工作" ? { observation: detail.summary.cuaObservation } : {}) });
        io.write("电脑恢复事实已保存；请刷新原记录查看停止证据或新截图，原结果未知保持。\n");
      } else if (action === "批准本次 MCP 操作" || action === "拒绝本次 MCP 操作") {
        await personalControl(directory, "POST", `/mcp/decide?operation=${operation}`, { decision: action === "批准本次 MCP 操作" ? "approved" : "rejected" });
        io.write("原 MCP 操作决定已登记；批准只消费一次，不表示操作成功。应答丢失请刷新原操作。\n");
      } else if (action === "核实原请求结束") {
        await personalControl(directory, "POST", `/mcp/recheck?operation=${operation}`);
        io.write("已登记原请求结果流核实；登记不证明远端结束，不会重新调用工具。请刷新原记录核实响应与远端结束。\n");
      } else if (action === "确认业务已生效" || action === "确认业务未生效") {
        const evidence = await io.question("独立核实业务效果后的证据（最多 8192 字符，不填凭据；/back 返回）：");
        if (evidence === "/back") continue;
        await personalControl(directory, "POST", `/mcp/resolve?operation=${operation}`, { effect: action === "确认业务已生效" ? "applied" : "not_applied", evidence });
        io.write("业务效果核实已保存；人工说明不证明原远端请求已结束。结束未核实时仍暂停并保留占用，请刷新原操作。\n");
      }
    }
    offset = 0;
  }
}
