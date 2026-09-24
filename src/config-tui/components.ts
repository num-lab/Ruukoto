/**
 * 配置中心共享组件（issue 21 §3）：ANSI 样式、悬浮层容器、秘密遮蔽输入框。
 *
 * 秘密卫生：MaskedInput 的缓冲只在组件内部，渲染永远输出 •••；秘密值
 * 不进入界面文本、重载状态文件与任何日志。
 */

import { VStack,truncateToWidth, type Component, type SelectListTheme, type SettingsListTheme } from "@earendil-works/pi-tui";

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

export const selectTheme: SelectListTheme = {
  selectedPrefix: (s: string) => cyan(s),
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: (s: string) => yellow(s),
};

export const settingsTheme: SettingsListTheme = {
  label: (s: string, selected: boolean) => (selected ? bold(s) : s),
  value: (s: string, selected: boolean) => (selected ? cyan(s) : dim(s)),
  description: dim,
  cursor: cyan("❯"),
  hint: dim,
};

/**
 * 悬浮层容器：与任务 TUI 的 OverlayBox 相同的最小形态（圆角边框由覆盖层
 * 宽度约束，这里只负责按键转发）。
 */
export class OverlayBox extends VStack {
  focused = false;
  onKey: ((data: string) => void) | null = null;
  forwardTo: { handleInput(data: string): void } | null = null;

  handleInput(data: string): void {
    if (this.onKey) {
      this.onKey(data);
      return;
    }
    this.forwardTo?.handleInput(data);
  }
}

/**
 * 遮蔽输入框：秘密逐字进入内部缓冲，渲染为 •••。
 * Enter 提交、Esc 取消、Backspace 删除；方向键等转义序列忽略。
 * （ponytail：不支持光标移动，秘密输入场景退格重输足够。）
 */
export class MaskedInput implements Component {
  private buffer = "";
  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  constructor(private readonly opts: { prompt?: string; placeholder?: string } = {}) {}

  getValue(): string {
    return this.buffer;
  }

  handleInput(data: string): void {
    if (data === "\r" || data === "\n") {
      this.onSubmit?.(this.buffer);
      this.buffer = "";
      return;
    }
    if (data === "\x1b") {
      this.buffer = "";
      this.onEscape?.();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.buffer = [...this.buffer].slice(0, -1).join("");
      return;
    }
    if (data.startsWith("\x1b")) return; // 方向键等转义序列
    for (const ch of data) {
      const code = ch.codePointAt(0)!;
      if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) this.buffer += ch;
    }
  }

  render(width: number): string[] {
    const prompt = this.opts.prompt ?? "> ";
    const body = this.buffer.length > 0 ? "•".repeat([...this.buffer].length) : dim(this.opts.placeholder ?? "");
    return [truncateToWidth(`${prompt}${body}`, Math.max(1, width - 1))];
  }

  invalidate(): void {}
}
