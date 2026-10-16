// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
export type BrowserNavigation = { history: string[]; index: number; draft: string; revision: number; error: boolean };

export function browserAddress(value: string): string | null {
  const address = value.trim();
  if (!address) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(address);
  const qualified = /^[a-z][a-z\d+.-]*:/i.test(address);
  let url: URL;
  try { url = new URL(local ? `http://${address}` : qualified ? address : `https://${address}`); }
  catch { return null; }
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
}

export function browserNavigation(url: string): BrowserNavigation {
  return { history: [url], index: 0, draft: url === "about:blank" ? "" : url, revision: 0, error: false };
}

export function navigateBrowser(state: BrowserNavigation, address: string): BrowserNavigation {
  const url = browserAddress(address);
  if (!url) return { ...state, draft: address, error: true };
  if (url === state.history[state.index]) return { ...state, draft: url, revision: state.revision + 1, error: false };
  const history = [...state.history.slice(0, state.index + 1), url];
  return { history, index: history.length - 1, draft: url, revision: state.revision + 1, error: false };
}

export function moveBrowser(state: BrowserNavigation, direction: -1 | 1): BrowserNavigation {
  const index = state.index + direction;
  return index < 0 || index >= state.history.length ? state : { ...state, index, draft: state.history[index], error: false };
}
