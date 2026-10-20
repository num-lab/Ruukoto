import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl } from "./personal-control.ts";
import type { listPersonalServiceGrants, PersonalServiceMode } from "./personal-service-operations.ts";

const MODES = { "auto-review": "自动审查", confirm: "请求确认", full_access: "完全访问" } as const;

export async function managePersonalPermissions(io: PersonalCliIO, directory: string) {
  while (true) {
    const action = await choose(io, "权限与授权", ["查看或更换默认模式", "查看或撤销长期服务授权", "返回"]);
    if (action === 2) return;
    if (action === 0) {
      const current = await personalControl<{ default: { mode: PersonalServiceMode }; qq: { mode: PersonalServiceMode } }>(directory, "GET", "/permissions");
      const scope = await choose(io, "选择新输入来源", [`本机与 Telegram：${MODES[current.default.mode]}`, `QQ：${MODES[current.qq.mode]}`, "返回"]);
      if (scope === 2) continue;
      const modes = ["auto-review", "confirm", "full_access"] as const;
      const selected = await choose(io, "默认模式只影响以后新接纳的输入与新计划，已有工作保持原权限", [...modes.map(mode => MODES[mode]), "返回"]);
      if (selected === 3) continue;
      if (modes[selected] === "full_access" && await choose(io, "完全访问使用后台账户权限，可访问目录外资料、网络和同账户凭据，免逐次审批；未知效果仍暂停", ["返回", "将新输入设为完全访问"]) === 0) continue;
      await personalControl(directory, "POST", "/permissions", { mode: modes[selected], ...(scope === 1 ? { scope: "qq" } : {}) });
      io.write("默认模式已保存；已有工作保持原权限。应答丢失请重新查看当前模式。\n");
    } else {
      let offset = 0;
      while (true) {
        const page = await personalControl<Awaited<ReturnType<typeof listPersonalServiceGrants>>>(directory, "GET", `/service/grants?offset=${offset}`);
        const choices = [...page.items.map(item => `${item.platform}：${item.source}；重启 ${item.unit}；机器 ${item.machine}；${item.active ? "有效" : "已撤销或失效"}`), ...(page.nextOffset === undefined ? [] : ["下一页授权"]), "返回"];
        io.write("长期服务授权仅能在原 IM 的具体待审批菜单创建；此处可查看和撤销，包括旧入口授权。资料读取授权从资料与网络工具管理。\n");
        const selected = await choose(io, "长期服务授权", choices);
        if (selected === choices.length - 1) break;
        if (selected === page.items.length) { offset = page.nextOffset!; continue; }
        const item = page.items[selected];
        if (!item.active) { io.write("原授权已撤销或失效。\n"); continue; }
        if (await choose(io, `撤销 ${item.platform} 对 ${item.unit} 的长期重启授权`, ["返回", "确认撤销"]) === 0) continue;
        await personalControl(directory, "POST", "/service/grants/revoke", { id: item.id, version: item.version });
        io.write("原长期授权已撤销；后续操作恢复逐次审批，已开始操作仍须分别核实效果与停止。应答丢失先刷新原授权。\n");
        offset = 0;
      }
    }
  }
}
