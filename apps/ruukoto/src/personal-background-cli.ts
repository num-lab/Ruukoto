import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl, PERSONAL_REQUEST_ID } from "./personal-control.ts";
import { PersonalError } from "./personal-error.ts";
import type { personalBackgroundView } from "./personal-background-processes.ts";

type View = ReturnType<typeof personalBackgroundView>;
export async function managePersonalBackground(io: PersonalCliIO, directory: string) {
  const pending = path.join(directory, "pending-background-end.json");
  async function end() {
    let requestId: string;
    const stat = fs.lstatSync(pending, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new PersonalError("background_pending_invalid", "原结束请求文件归属无法核实，请保留档案。");
      const value: unknown = JSON.parse(fs.readFileSync(pending, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("requestId" in value) || typeof value.requestId !== "string" || !PERSONAL_REQUEST_ID.test(value.requestId)) throw new PersonalError("background_pending_invalid", "原结束请求无法核实，请保留档案。");
      requestId = value.requestId;
    } else {
      if (await choose(io, "停止并核实本次结束请求涉及的后台；保留会话和历史", ["返回", "结束本会话后台"]) === 0) return;
      requestId = randomUUID(); fs.writeFileSync(pending, JSON.stringify({ requestId }) + "\n", { flag: "wx", mode: 0o600 });
    }
    const route = `/background/end?request=${requestId}`;
    const receipt = await personalControl<{ accepted: boolean; stopVerified?: boolean }>(directory, "GET", route);
    if (!receipt.accepted) await personalControl(directory, "POST", route);
    const result = await personalControl<{ accepted: boolean; stopVerified?: boolean }>(directory, "GET", route);
    if (result.stopVerified) { fs.unlinkSync(pending); io.write("本次涉及的会话后台停止已核实；会话和历史保留。\n"); }
    else io.write("结束请求已登记，停止仍待核实；原请求已保留。再次选择结束只查询原范围，不涉及之后新启动的后台。\n");
  }
  let offset = 0;
  while (true) {
    const page = await personalControl<{ processes: View[]; nextOffset: number | null }>(directory, "GET", `/background?offset=${offset}`);
    const choices = [...page.processes.map(value => `${value.command.slice(0, 80)}；${value.state}`), ...(page.nextOffset === null ? [] : ["下一页后台"]), "结束本会话后台", "返回"];
    const selected = await choose(io, "会话后台", choices), action = choices[selected];
    if (action === "返回") return;
    if (action === "结束本会话后台") { await end(); offset = 0; continue; }
    if (action === "下一页后台") { offset = page.nextOffset!; continue; }
    const id = page.processes[selected].process_id;
    let stream: "stdout" | "stderr" = "stdout", at = 0;
    while (true) {
      const process = await personalControl<View>(directory, "GET", `/background?process=${encodeURIComponent(id)}`);
      io.write(`\n${process.command}\n状态：${process.state}；停止${process.stopVerified ? "已核实" : "未核实"}；退出码${process.exit?.code ?? "未知"}。退出和停止都不证明业务成功或外部写入回滚。\n`);
      const actions = ["刷新状态", "查看输出", "查看错误", "停止此后台", "返回后台列表"];
      const action = actions[await choose(io, "原后台", actions)];
      if (action === "返回后台列表") break;
      if (action === "停止此后台") { await personalControl(directory, "POST", `/background/stop?process=${encodeURIComponent(id)}`); io.write("已登记停止，登记不代表已停止；请刷新核实。\n"); }
      else if (action === "查看输出" || action === "查看错误") {
        stream = action === "查看错误" ? "stderr" : "stdout"; at = 0;
        for (;;) {
          const output = await personalControl<{ text: string; base64: string; nextOffset: number; totalBytes: number; partial: boolean }>(directory, "GET", `/background/output?process=${encodeURIComponent(id)}&stream=${stream}&offset=${at}`);
          io.write(`${stream}${output.partial ? "（仅捕获片段）" : ""}：\n${output.text}\n原字节base64：${output.base64}\n`);
          if (output.nextOffset >= output.totalBytes || await choose(io, "日志", ["返回原后台", "下一页日志"]) === 0) break;
          at = output.nextOffset;
        }
      }
    }
  }
}
