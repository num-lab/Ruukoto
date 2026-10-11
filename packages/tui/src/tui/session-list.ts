import { SelectList, truncateToWidth, type SelectItem, type SelectListTheme, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export function activityAgo(at: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000)) || 0;
  const [size, unit]: [number, string] = seconds >= 86400 ? [86400, "day"] : seconds >= 3600 ? [3600, "hour"] : seconds >= 60 ? [60, "minute"] : [1, "second"];
  const count = Math.floor(seconds / size);
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** 复用 SelectList 的键盘选择与滚动，每项两行，项间空一行。 */
export class TwoLineSelectList extends SelectList {
  constructor(private readonly entries: Array<Omit<SelectItem, "description"> & { description?: string | (() => string) }>, private readonly visible: number, private readonly colors: SelectListTheme) {
    super(entries.map(({ value, label }) => ({ value, label })), visible, colors);
  }

  override render(width: number): string[] {
    const selected = this.entries.findIndex((item) => item.value === this.getSelectedItem()?.value);
    const start = Math.max(0, Math.min(selected - Math.floor(this.visible / 2), this.entries.length - this.visible));
    return super.render(width).flatMap((line, index) => {
      const item = index < this.visible ? this.entries[start + index] : undefined;
      const detail = typeof item?.description === "function" ? item.description() : item?.description ?? "";
      return item ? [...(index > 0 ? [""] : []), line, this.colors.description(truncateToWidth(`  ${detail}`, width, ""))] : [line];
    });
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" && (event.y % 3 === 2 || event.y >= Math.min(this.visible, this.entries.length) * 3 - 1)) return;
    return super.handleMouse({ ...event, y: Math.floor(event.y / 3) });
  }
}
