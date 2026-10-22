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
    const choices = ["新增服务", ...services.map(service => service.label), ...(current?.version === 1 ? ["迁入服务启停配置"] : []), "返回"];
    const selected = await choose(io, "个人 MCP 服务", choices);
    if (selected === choices.length - 1) return;
    if (current?.version === 1 && selected === services.length + 1) {
      if (await choose(io, "迁入后保留原工具与历史，旧程序不能再打开此 MCP 配置", ["返回", "确认迁入服务启停配置"]) === 0) return;
      await migratePersonalMcp(profile);
      io.write("MCP 已迁入服务启停配置；原服务保持启用，旧历史与请求证据保留。\n");
      return;
    }
    const original = selected ? services[selected - 1] : undefined;
    const version = current?.version ?? 2;
    if (original) {
      io.write(`\n${original.label}\n端点：${original.endpoint}\n认证：${original.credential ? "绑定私有令牌文件" : "显式匿名"}\n固定允许工具：${original.tools.map(tool => tool.name).join("、") || "无"}\n`);
      const actions = ["查看固定工具定义", "替换配置并重新选择工具", "移除服务", ...(version === 2 ? [original.enabled ? "停用服务" : "启用服务"] : []), "返回"];
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
    const target = { id: randomUUID(), label, endpoint, ...(credential ? { credential } : {}) };
    const discovered = await discoverPersonalMcp(target);
    const tools: PersonalMcpService["tools"] = [];
    for (const tool of discovered) {
      io.write(`\n服务返回的原工具定义：\n${JSON.stringify(tool, null, 2)}\n`);
      const action = await choose(io, `是否允许工具 ${tool.name}`, ["不加入允许列表", "加入允许列表", "取消本次配置"]);
      if (action === 2) return;
      if (action === 1) tools.push(tool);
    }
    if (!tools.length) { io.write("没有选择允许工具，未保存服务。\n"); return; }
    if (await choose(io, `${label}：固定允许 ${tools.map(tool => tool.name).join("、")}`, ["返回", "保存服务与固定工具"]) === 0) return;
    await savePersonalMcp(profile, { version, generation: randomUUID(), services: [...services.filter(service => service !== original), { ...target, tools, ...(version === 2 ? { enabled: original?.enabled ?? true } : {}) }] });
    io.write("MCP 配置与原工具定义已保存；配置不授予操作权限。请启动后台；旧操作从管理菜单核实，不要换服务重发。\n");
  } finally { profile.release(); }
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
    let detailOffset = 0;
    while (true) {
      const detail = await personalControl<Awaited<ReturnType<typeof mcpDetail>>>(directory, "GET", `/mcp/operation?operation=${operation}&offset=${detailOffset}`);
      io.write(`\n${personalMcpDescription(detail.summary)}\n原请求、响应与核实证据：\n${detail.text}\n`);
      const actions = ["刷新原操作", ...(detail.nextOffset === undefined ? [] : ["下一页原记录"]), ...(detail.summary.canDecide ? ["批准本次 MCP 操作", "拒绝本次 MCP 操作"] : []), ...(detail.summary.canResolve ? ["确认业务已生效", "确认业务未生效"] : []), ...(detail.summary.canRecheck ? ["核实原请求结束"] : []), "返回操作列表"];
      const action = actions[await choose(io, "原 MCP 操作", actions)];
      if (action === "返回操作列表") break;
      if (action === "下一页原记录") { detailOffset = detail.nextOffset!; continue; }
      detailOffset = 0;
      if (action === "批准本次 MCP 操作" || action === "拒绝本次 MCP 操作") {
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
