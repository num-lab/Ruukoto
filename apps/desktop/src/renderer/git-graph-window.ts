// Note: 见 .agents/notes/implemented/feature/2026-10-18-desktop-git-graph-windowing.md

export const GIT_GRAPH_ROW_HEIGHT = 28;
export const GIT_GRAPH_INITIAL_ROWS = 40;
export const GIT_GRAPH_OVERSCAN_ROWS = 6;

// 已测量展开行的内容高度；extra 是从固定行高之外增加的高度。
export interface GitGraphExpansion {
  row: number;
  extra: number;
}

export interface GitGraphMetrics {
  count: number;
  totalHeight: number;
  top(row: number): number;
}

export interface GitGraphRange {
  first: number;
  last: number;
}

export interface GitGraphRenderWindow extends GitGraphRange {
  pinned: { row: number; before: boolean } | null;
}

// 展开高度按行号前缀和参与总高度与偏移；sorted 输入，重复行号只取第一个。
export function gitGraphMetrics(count: number, expansions: readonly GitGraphExpansion[]): GitGraphMetrics {
  const rows: number[] = [], prefix: number[] = [0];
  for (const expansion of [...expansions].sort((left, right) => left.row - right.row)) {
    if (!Number.isInteger(expansion.row) || expansion.row < 0 || expansion.row >= count || !(expansion.extra > 0)) continue;
    if (rows.length && rows[rows.length - 1] === expansion.row) continue;
    rows.push(expansion.row);
    prefix.push(prefix[prefix.length - 1]! + expansion.extra);
  }
  const top = (row: number): number => {
    const clamped = Math.max(0, Math.min(count, row));
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (rows[middle]! < clamped) low = middle + 1;
      else high = middle;
    }
    return clamped * GIT_GRAPH_ROW_HEIGHT + prefix[low]!;
  };
  return { count, totalHeight: top(count), top };
}

// 可视行范围：行 bottom = top(row + 1)，因此“第一行底边超过 low”与“第一行顶边达到 high”都能二分。
export function gitGraphRange(metrics: GitGraphMetrics, scrollTop: number, viewportHeight: number, overscan = GIT_GRAPH_OVERSCAN_ROWS): GitGraphRange {
  const count = metrics.count;
  if (!count) return { first: 0, last: 0 };
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return { first: 0, last: Math.min(count, GIT_GRAPH_INITIAL_ROWS) };
  const position = Number.isFinite(scrollTop) ? scrollTop : 0;
  const margin = overscan * GIT_GRAPH_ROW_HEIGHT;
  const low = position - margin, high = position + viewportHeight + margin;
  let lowIndex = 0, highIndex = count;
  while (lowIndex < highIndex) {
    const middle = (lowIndex + highIndex) >> 1;
    if (metrics.top(middle + 1) > low) highIndex = middle;
    else lowIndex = middle + 1;
  }
  const first = Math.min(lowIndex, count - 1);
  let left = 0, right = count;
  while (left < right) {
    const middle = (left + right) >> 1;
    if (metrics.top(middle) < high) left = middle + 1;
    else right = middle;
  }
  return { first, last: Math.max(first + 1, Math.min(left, count)) };
}

export function gitGraphClampScroll(scrollTop: number, totalHeight: number, viewportHeight: number): number {
  const maximum = Math.max(0, totalHeight - Math.max(0, viewportHeight));
  return Math.min(Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0), maximum);
}

// 焦点行滚出窗口时单独以绝对定位行保留，不并入窗口范围，避免多渲染中间所有行。
export function gitGraphRenderWindow(metrics: GitGraphMetrics, scrollTop: number, viewportHeight: number, focusedRow: number | null, overscan = GIT_GRAPH_OVERSCAN_ROWS): GitGraphRenderWindow {
  const range = gitGraphRange(metrics, scrollTop, viewportHeight, overscan);
  const pinned = focusedRow !== null && Number.isInteger(focusedRow) && focusedRow >= 0 && focusedRow < metrics.count && (focusedRow < range.first || focusedRow >= range.last) ? { row: focusedRow, before: focusedRow < range.first } : null;
  return { first: range.first, last: range.last, pinned };
}
