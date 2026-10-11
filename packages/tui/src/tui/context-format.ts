/** 上下文用量固定以 k/m 显示，小于 1k 时保留非零的细小用量。 */
export function formatContextTokens(tokens: number): string {
  const unit = tokens >= 999_950 ? "m" : "k";
  const value = tokens / (unit === "m" ? 1_000_000 : 1000);
  return `${Number(value.toFixed(value < 1 ? 3 : 1))}${unit}`;
}

/** 已保存的 ANSI 长条按当前列宽重排，图例的旧裸数值也补上单位。 */
export function contextDisplayRow(row: string, width: number): string {
  if (/^█+$/.test(row.replace(/\x1b\[[0-9;]*m/g, "").trim())) {
    if (width <= 0) return "";
    const segments = [...row.matchAll(/((?:\x1b\[[0-9;]*m)*)(█+)/g)];
    const total = segments.reduce((sum, part) => sum + part[2]!.length, 0);
    const minimum = width >= segments.length ? 1 : 0;
    const counts = segments.map((part) => Math.max(minimum, Math.round(part[2]!.length / total * width)));
    let remaining = width - counts.reduce((sum, count) => sum + count, 0);
    while (remaining !== 0) {
      const weights = remaining > 0 ? segments.map((part) => part[2]!.length) : counts;
      const index = weights.indexOf(Math.max(...weights));
      counts[index]! += remaining > 0 ? 1 : -1;
      remaining += remaining > 0 ? -1 : 1;
    }
    return segments.map((part, index) => counts[index] ? `${part[1]}${"█".repeat(counts[index]!)}\x1b[0m` : "").join("");
  }
  return row.replace(/(■(?:\x1b\[[0-9;]*m)*\s+[^■\n]*?\s)(\d+)(?=\s*(?:\(|\s{2}|$))/g,
    (_match, label: string, value: string) => label + formatContextTokens(Number(value)));
}
