import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl } from "./personal-control.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { PersonalError } from "./personal-error.ts";
import { personalReadPath, readPersonalTools, savePersonalTools, type PersonalToolsConfig } from "./personal-tools-config.ts";
import { personalToolDescription } from "./personal-tools-controls.ts";
import type { toolList, toolDetail } from "./personal-tools.ts";

export async function configurePersonalTools(io: PersonalCliIO, directory: string): Promise<void> {
  const profile = lockPersonalProfile(directory);
  try {
    const current = readPersonalTools(profile);
    let workspace = current?.workspace;
    io.write("资料目录供个人文件工具使用；目录外读取与网络沿原工作权限核实。凭据只绑定环境变量名称，不粘贴密钥。配置不会扩大已有工作的权限。输入 /back 返回。\n");
    if (current) {
      io.write(`当前资料目录：${current.workspace}\nHTTP 凭据：${current.credentials.map(value => value.name).join("、") || "无"}\nWeb Search：${current.search ? "启用 Tavily" : "停用"}\n`);
      const selected = await choose(io, "个人资料目录", ["继续使用当前目录", "选择另一个现有目录", "返回"]);
      if (selected === 2) return;
      if (selected === 1) workspace = undefined;
    }
    if (!workspace) {
      const input = (await io.question("资料目录绝对路径（已存在、独立于后台档案与源码）：")).trim();
      if (input === "/back") return;
      if (!path.isAbsolute(input)) throw new PersonalError("tools_config_invalid", "请选择已存在资料目录的绝对路径，再运行配置向导。");
      const selected = personalReadPath(profile.directory, input);
      if (!fs.statSync(selected.path).isDirectory()) throw new PersonalError("tools_config_invalid", "资料入口须为目录，请重新选择个人事务专用目录。");
      workspace = selected.path;
    }
    const credentials = current?.credentials.map(value => ({ ...value })) ?? [];
    while (true) {
      const options = ["新增 HTTP 具名凭据", ...credentials.map(value => `${value.name}：${value.host} / ${value.header} ← ${value.env}`), "完成凭据配置", "取消本次配置"];
      const selected = await choose(io, "HTTP 凭据绑定", options);
      if (selected === options.length - 1) return;
      if (selected === options.length - 2) break;
      const original = selected ? credentials[selected - 1] : undefined;
      if (original) {
        const action = await choose(io, `凭据 ${original.name}`, ["修改绑定", "移除绑定", "返回"]);
        if (action === 2) continue;
        if (action === 1) { credentials.splice(selected - 1, 1); continue; }
      }
      const name = (await io.question(`凭据名称（英文、数字、下划线或短横线${original ? `；回车保留 ${original.name}` : ""}）：`)).trim() || original?.name || "";
      if (name === "/back") return;
      const host = ((await io.question(`允许注入的主机（如 api.example.com${original ? `；回车保留 ${original.host}` : ""}）：`)).trim() || original?.host || "").toLowerCase();
      if (host === "/back") return;
      const headerChoice = await choose(io, "凭据注入头", ["Authorization（环境变量保存完整头值，如 Bearer …）", "X-API-Key", "取消本次配置"]);
      if (headerChoice === 2) return;
      const env = (await io.question(`凭据环境变量名称（不填密钥${original ? `；回车保留 ${original.env}` : ""}）：`)).trim() || original?.env || "";
      if (env === "/back") return;
      const item = { name, host, header: headerChoice === 0 ? "authorization" : "x-api-key", env };
      if (original) credentials.splice(selected - 1, 1, item); else credentials.push(item);
    }
    const searchChoice = await choose(io, "Web Search", ["启用 Tavily", "停用 Tavily", "取消本次配置"]);
    if (searchChoice === 2) return;
    let search: PersonalToolsConfig["search"];
    if (searchChoice === 0) {
      const apiKeyEnv = (await io.question(`Tavily 环境变量名称（环境变量保存原始 API key；回车使用 ${current?.search?.apiKeyEnv ?? "TAVILY_API_KEY"}）：`)).trim() || current?.search?.apiKeyEnv || "TAVILY_API_KEY";
      if (apiKeyEnv === "/back") return;
      search = { apiKeyEnv };
    }
    const selected = personalReadPath(profile.directory, workspace);
    const config = { version: 1, generation: randomUUID(), workspace, identity: { dev: selected.dev, ino: selected.ino }, credentials, ...(search ? { search } : {}) };
    io.write(`资料目录：${workspace}\nHTTP 凭据绑定：${credentials.length} 项\nWeb Search：${search ? "启用 Tavily" : "停用"}\n`);
    if (await choose(io, "保存资料与网络配置", ["返回", "保存配置"]) === 0) return;
    await savePersonalTools(profile, config);
    io.write("资料与网络配置已保存。请启动后台；资料授权可在运行中查看和撤销，原操作的批准、效果与结束分别核实。\n");
  } finally { profile.release(); }
}

async function manageOperations(io: PersonalCliIO, directory: string): Promise<void> {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof toolList>>>(directory, "GET", `/tools/operations?offset=${offset}`);
    const choices = [...page.items.map(personalToolDescription), ...(page.nextOffset === undefined ? [] : ["下一页工具操作"]), "返回"];
    const selected = await choose(io, "原工具操作", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const operation = page.items[selected].operation;
    let detailOffset = 0;
    while (true) {
      const detail = await personalControl<Awaited<ReturnType<typeof toolDetail>>>(directory, "GET", `/tools/operation?operation=${operation}&offset=${detailOffset}`);
      io.write(`\n${personalToolDescription(detail.summary)}\n原请求、结果与核实证据：\n${detail.text}\n`);
      const actions = ["刷新原操作", ...(detail.nextOffset === undefined ? [] : ["下一页原记录"]), ...(detail.summary.canDecide ? ["批准本次工具操作", "拒绝本次工具操作"] : []), ...(detail.summary.canResolve ? ["确认业务已生效", "确认业务未生效"] : []), ...(detail.summary.canVerifyStop ? ["核实原外部请求已结束"] : []), "返回操作列表"];
      const action = actions[await choose(io, "原工具操作", actions)];
      if (action === "返回操作列表") break;
      if (action === "下一页原记录") { detailOffset = detail.nextOffset!; continue; }
      detailOffset = 0;
      if (action === "批准本次工具操作" || action === "拒绝本次工具操作") {
        await personalControl(directory, "POST", "/tools/decide", { operation, decision: action === "批准本次工具操作" ? "approved" : "rejected" });
        io.write("原工具操作决定已登记；批准只消费一次，不表示操作成功。应答丢失请刷新原操作。\n");
      } else if (action === "确认业务已生效" || action === "确认业务未生效" || action === "核实原外部请求已结束") {
        const stop = action === "核实原外部请求已结束";
        io.write(stop ? "请独立核实原外部请求已结束；本地取消、断线和超时不能证明远端结束。\n" : "请独立核实实际业务效果；业务效果说明不证明原外部请求已结束。\n");
        const evidence = await io.question("核实证据（非空，最多8192字符，不填凭据；/back 返回）：");
        if (evidence === "/back") continue;
        await personalControl(directory, "POST", stop ? "/tools/stop" : "/tools/resolve", { operation, ...(stop ? {} : { effect: action === "确认业务已生效" ? "applied" : "not_applied" }), evidence });
        io.write(stop ? "结束核实已保存；业务效果未知仍须单独核实。请刷新原操作。\n" : "业务效果核实已保存；原请求结束未核实时仍暂停并保留占用。请刷新原操作。\n");
      }
    }
    offset = 0;
  }
}

async function manageGrants(io: PersonalCliIO, directory: string): Promise<void> {
  let offset = 0;
  while (true) {
    const page = await personalControl<{ items: Array<{ id: string; path: string; revoked: boolean }>; nextOffset?: number }>(directory, "GET", `/tools/grants?offset=${offset}`);
    const choices = ["新增只读资料授权", ...page.items.map(value => `${value.path}（${value.revoked ? "已撤销" : "可读取"}）`), ...(page.nextOffset === undefined ? [] : ["下一页资料授权"]), "返回"];
    const selected = await choose(io, "资料读取授权", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length + 1) { offset = page.nextOffset!; continue; }
    if (selected === 0) {
      const target = (await io.question("开放读取的现有文件或目录绝对路径（不授予修改权限；/back 返回）：")).trim();
      if (target === "/back") continue;
      if (await choose(io, `允许读取：${target}`, ["返回", "确认开放读取"]) === 0) continue;
      await personalControl(directory, "POST", "/tools/grant", { path: target });
      io.write("只读资料授权已登记；可随时从本菜单撤销。\n");
    } else {
      const grant = page.items[selected - 1];
      if (grant.revoked) { io.write("此资料授权已撤销。\n"); continue; }
      if (await choose(io, `撤销读取：${grant.path}`, ["返回", "确认撤销读取"]) === 0) continue;
      await personalControl(directory, "POST", "/tools/revoke", { id: grant.id });
      io.write("资料读取授权已撤销；后续操作重新核实范围，原审批不会因此扩大权限。\n");
    }
    offset = 0;
  }
}

async function manageArtifacts(io: PersonalCliIO, directory: string): Promise<void> {
  let offset = 0;
  while (true) {
    const page = await personalControl<{ items: Array<{ artifact: string; kind: string; target: string; bytes: number; partial: boolean; mime?: string }>; nextOffset?: number }>(directory, "GET", `/tools/artifacts?offset=${offset}`);
    const choices = [...page.items.map(value => `${value.kind}：${value.target}；${value.bytes} 字节；${value.partial ? "仅捕获片段" : "完整捕获"}`), ...(page.nextOffset === undefined ? [] : ["下一页产物"]), "返回"];
    const selected = await choose(io, "产物导出", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const artifact = page.items[selected];
    if (artifact.partial) { io.write("原产物仅捕获片段，不能完整导出；请从原工具操作分页核实已有字节。\n"); continue; }
    const destination = (await io.question("导出为新文件的绝对路径（已有文件不会被覆盖；/back 返回）：")).trim();
    if (destination === "/back") continue;
    if (await choose(io, `导出到：${destination}`, ["返回", "核实完整原文并导出"]) === 0) continue;
    await personalControl(directory, "POST", "/tools/export", { artifact: artifact.artifact, destination });
    io.write("完整产物已核实并导出到新文件；原产物仍保留。\n");
  }
}

export async function managePersonalTools(io: PersonalCliIO, directory: string): Promise<void> {
  while (true) {
    const selected = await choose(io, "资料与网络工具", ["原工具操作", "资料读取授权", "产物导出", "返回"]);
    if (selected === 3) return;
    if (selected === 0) await manageOperations(io, directory);
    else if (selected === 1) await manageGrants(io, directory);
    else await manageArtifacts(io, directory);
  }
}
