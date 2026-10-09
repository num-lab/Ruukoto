/**
 * 假终端：TUI 测试直接驱动（14、30、32、33、66 号共用）。
 */

import type { Terminal } from "@earendil-works/pi-tui";

export class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  readonly kittyProtocolActive = false;
  private written: string[] = [];
  private onInput: ((data: string) => void) | null = null;
  private onResize: (() => void) | null = null;
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** 与 ProcessTerminal 一致：括号粘贴整段作为一次输入送达。 */
  paste(text: string): void {
    this.onInput?.(`\x1b[200~${text}\x1b[201~`);
  }
  /**
   * 模拟 StdinBuffer 的分帧：控制键（\r \n \x03 \x1b 开头序列）与文本分别
   * 到达——真实终端不会把 "/cmd\r" 合成一个输入事件。
   */
  send(data: string): void {
    let textBuf = "";
    const flush = () => {
      if (textBuf) {
        this.onInput?.(textBuf);
        textBuf = "";
      }
    };
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        flush();
        // ESC 序列（如 \x1b[B）作为整体
        const rest = data.slice(i);
        const m = /^\x1b\[[A-Za-z]~?/.exec(rest) ?? /^\x1b./.exec(rest);
        const seq = m ? m[0] : "\x1b";
        this.onInput?.(seq);
        i += seq.length - 1;
      } else if (ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\t") {
        flush();
        this.onInput?.(ch);
      } else {
        textBuf += ch;
      }
    }
    flush();
  }
  output(): string {
    return this.written.join("");
  }
  clearOutput(): void {
    this.written = [];
  }
}
