import type { BackgroundProcessView } from "@ruukoto/core/background-processes.ts";

export function backgroundProcessStatus(process: BackgroundProcessView): string {
  return ({ starting: "启动中", running: "运行中", stop_requested: "停止核实中", stopped: "已核实停止", stop_unverified: "停止未核实，仍占用目录" })[process.state];
}
