import { randomUUID } from "node:crypto";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl } from "./personal-control.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { readPersonalBrowser, savePersonalBrowser } from "./personal-browser-config.ts";
import { personalBrowserDescription } from "./personal-browser-controls.ts";
import type { browserList, browserDetail } from "./personal-browser.ts";
import { managePersonalArtifacts } from "./personal-tools-cli.ts";

export async function configurePersonalBrowser(io: PersonalCliIO, directory: string) {
  const profile = lockPersonalProfile(directory);
  try {
    const current = readPersonalBrowser(profile);
    io.write("先在后台机器准备 agent-browser v0.39.1 官方原生程序和 Chromium；向导不安装或提权。页面和登录资料按档案保留。输入 /back 返回。\n");
    if (current) {
      io.write(`原生程序：${current.binaryPath}\nChromium：${current.chromePath}\n窗口：${current.headed ? "有头" : "无头"}\n`);
      if (await choose(io, "浏览器配置", ["返回", "修改路径与窗口"]) === 0) return;
    }
    const binaryPath = (await io.question(`官方原生程序绝对路径${current ? "（回车保留）" : ""}：`)).trim() || current?.binaryPath || "";
    if (binaryPath === "/back") return;
    const chromePath = (await io.question(`Chromium 可执行文件绝对路径${current ? "（回车保留）" : ""}：`)).trim() || current?.chromePath || "";
    if (chromePath === "/back") return;
    const window = await choose(io, "浏览器窗口", ["无头（Linux 可用 dashboard 人工登录）", "有头（需要可用桌面）", "返回"]);
    if (window === 2 || await choose(io, "保存浏览器配置；只在完全访问的拥有者新输入开放", ["返回", "保存配置"]) === 0) return;
    await savePersonalBrowser(profile, { version: 1, generation: randomUUID(), binaryPath, chromePath, headed: window === 1 });
    io.write("浏览器配置已保存。启动后台后可从浏览器管理查询状态；程序或 Chromium 缺失只拒绝浏览器调用。\n");
  } finally { profile.release(); }
}


async function manageOperations(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof browserList>>>(directory, "GET", `/browser/operations?offset=${offset}`);
    const choices = [...page.items.map(personalBrowserDescription), ...(page.nextOffset === undefined ? [] : ["下一页"]), "返回"];
    const selected = await choose(io, "浏览器原操作", choices);
    if (selected === choices.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const operation = page.items[selected].operation;
    let detailOffset = 0;
    while (true) {
      const detail = await personalControl<Awaited<ReturnType<typeof browserDetail>>>(directory, "GET", `/browser/operation?operation=${operation}&offset=${detailOffset}`);
      io.write(`${personalBrowserDescription(detail.summary)}\n原记录与证据：\n${detail.text}\n`);
      const actions = ["刷新", ...(detail.nextOffset === undefined ? [] : ["下一页记录"]), ...(detail.summary.canResolve ? ["确认网页效果已生效", "确认网页效果未生效"] : []), ...(detail.summary.canVerifyStop ? ["停止并核实原浏览器执行"] : []), "返回列表"];
      const action = actions[await choose(io, "原浏览器操作", actions)];
      if (action === "返回列表") break;
      if (action === "下一页记录") { detailOffset = detail.nextOffset!; continue; }
      detailOffset = 0;
      if (action === "停止并核实原浏览器执行") {
        const result = await personalControl<{ stopped: boolean }>(directory, "POST", `/browser/stop?operation=${operation}`);
        io.write(result.stopped ? "原执行停止已核实；网页效果未知仍须独立核实，不自动重发。\n" : "原执行停止仍未核实，占用保留；请保留档案并检查原进程。\n");
      } else if (action === "确认网页效果已生效" || action === "确认网页效果未生效") {
        io.write("先独立查看网页或服务端实际结果；浏览器关闭、取消或崩溃不能证明写入没有发生。\n");
        const evidence = await io.question("核实证据（非空，最多8192字符，不填凭据；/back 返回）：");
        if (evidence === "/back") continue;
        await personalControl(directory, "POST", `/browser/resolve?operation=${operation}`, { effect: action === "确认网页效果已生效" ? "applied" : "not_applied", evidence });
        io.write("网页效果核实已保存；停止未核实时继续保留占用。原动作不会重发。\n");
      }
    }
  }
}

async function chooseMode(io: PersonalCliIO, directory: string) {
  const modes = ["auto-review", "confirm", "full_access"] as const;
  const selected = await choose(io, "为后续新输入选择默认模式；已有工作保持原权限", ["自动审查", "请求确认", "完全访问：使用后台账户已有权限并免逐次操作审批", "返回"]);
  if (selected === 3) return;
  if (selected === 2 && await choose(io, "完全访问能读取后台账户的文件、网络与凭据，未知操作仍暂停", ["返回", "为新输入启用完全访问"]) === 0) return;
  await personalControl(directory, "POST", "/permissions", { mode: modes[selected] });
  io.write("新输入默认模式已保存；受限模式与子工作不开放宿主浏览器。\n");
}

export async function managePersonalBrowser(io: PersonalCliIO, directory: string) {
  while (true) {
    const selected = await choose(io, "个人浏览器", ["查看连接状态", "原操作与网页效果核实", "停止浏览器并核实执行结束", "导出截图或文件产物", "设置新输入默认模式", "返回"]);
    if (selected === 5) return;
    if (selected === 0) {
      const value = await personalControl<{ enabled: boolean; state?: string; kind?: string; failure?: string; dashboardUrl?: string }>(directory, "GET", "/browser");
      io.write(value.enabled ? `连接：${value.state}${value.kind ? `；${value.kind}` : ""}${value.failure ? `；${value.failure}` : ""}\n${value.dashboardUrl ? `人工操作地址：${value.dashboardUrl}\n` : ""}` : "尚未配置浏览器，请停止后台后通过浏览器配置选择路径。\n");
    } else if (selected === 1) await manageOperations(io, directory);
    else if (selected === 2) {
      const result = await personalControl<{ stopped: boolean }>(directory, "POST", "/browser/stop");
      io.write(result.stopped ? "浏览器执行停止已核实；原网页效果仍须单独核实。\n" : "停止尚未核实，原绑定与占用保留。\n");
    } else if (selected === 3) await managePersonalArtifacts(io, directory);
    else await chooseMode(io, directory);
  }
}
