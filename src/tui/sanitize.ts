/**
 * 终端输出安全：不可信内容（消息、工具日志、文件名、审批参数）渲染前的
 * 控制序列处理。
 *
 * 复用 pi-tui 的 stripTerminalSequences，并补齐其未覆盖的范围（已核实其实
 * 现：只剥离以 m/G/K/H/J 结尾的 CSI、OSC、APC）：
 * - 任意终止字节的 CSI（擦屏、光标控制、私有模式如 ?25l/?2004h）；
 * - 两字节 ESC 序列与裸 ESC；
 * - 残留 C0（除 \n \t）、DEL、C1 控制字符显示为转义形式（如 \x07），
 *   避免不可见字符影响参数辨识。
 *
 * 只改变展示：历史与审批的执行参数在数据源保持原值，本函数仅用于渲染。
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

// 完整 CSI：ESC [ 参数字节 中间字节 终止字节
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// OSC：ESC ] …（BEL 或 ST 结尾；无结尾则到串尾）
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
// APC：ESC _ …（BEL 或 ST 结尾）
const APC_RE = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
// 两字节 ESC 序列（如 ESC c 复位、ESC ( 0 字符集切换）
const ESC2_RE = /\x1b[@-Z\\-_]/g;
// 残留控制字符：C0（除 \n \t）、DEL、C1
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function escapeControl(ch: string): string {
  return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

/** 剥离/转义不可信文本中的终端控制内容；返回可安全渲染的文本。 */
export function sanitizeForDisplay(input: string): string {
  if (input.length === 0) return input;
  let out = input;
  // 先走上游（覆盖 SGR/OSC8 等常见序列），再补齐其余形态
  if (out.includes("\x1b")) {
    out = stripTerminalSequences(out);
    out = out.replace(CSI_RE, "").replace(OSC_RE, "").replace(APC_RE, "").replace(ESC2_RE, "");
    // 裸 ESC（不构成序列）转义显示
    out = out.replace(/\x1b/g, "\\x1b");
  }
  // 注意：带 /g 的正则 test() 有 lastIndex 状态，这里直接 replace
  out = out.replace(CTRL_RE, escapeControl);
  return out;
}
