import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { GitGraphPanel } from "../../../../apps/desktop/src/renderer/git-graph.tsx";
import "../../../../apps/desktop/src/renderer/style.css";

const LONG_SUBJECT = `Long subject ${"preserve commit information ".repeat(30)}`;
const full = Array.from({ length: 405 }, (_value, index) => ({
  id: `c${String(index).padStart(4, "0")}`,
  parents: index < 404 ? [`c${String(index + 1).padStart(4, "0")}`] : ["older"],
  subject: index === 0 ? LONG_SUBJECT : `Commit ${index}`,
  author: "fixture",
  date: "2026-10-17",
  refs: index === 0 ? [{ name: "feature/long-branch-name", type: "branch", remote: "origin" }] : [],
}));
const short = Array.from({ length: 60 }, (_value, index) => ({ id: `r${index}`, parents: index < 59 ? [`r${index + 1}`] : [], subject: `Shorter ${index}`, author: "fixture", date: "2026-10-17", refs: [] }));

function Fixture() {
  const [count, setCount] = useState(200), [dataset, setDataset] = useState("full"), [requests, setRequests] = useState(0), [version, setVersion] = useState(0);
  const hold = useRef(true);
  const commits = dataset === "full" ? full.slice(0, count) : dataset === "short" ? short : [];
  const nextCursor = dataset === "full" && count < full.length ? `hold-${version}` : null;
  return <>
    <div id="panel" style={{ width: 320, height: 260, display: "flex" }}><GitGraphPanel active name="window fixture" loading={false} repository={{ commits, head: dataset === "full" ? full[0]!.id : null, nextCursor }} onRefresh={() => setDataset("short")} onLoadMore={() => { if (hold.current) return; setRequests(value => value + 1); setCount(value => Math.min(full.length, value + 200)); }} /></div>
    <button id="release" onClick={() => { hold.current = false; setVersion(value => value + 1); }}>release</button>
    <button id="more" onClick={() => setVersion(value => value + 1)}>more</button>
    <button id="short" onClick={() => setDataset("short")}>short</button>
    <button id="empty" onClick={() => setDataset("empty")}>empty</button>
    <button id="full" onClick={() => setDataset("full")}>full</button>
    <output id="loaded">requests: {requests}</output>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

interface Check { name: string; pass: boolean }
const result: { failed: number; checks: Check[]; error?: string; requests?: number; contentWidth?: number; viewportWidth?: number; scrollLeft?: number; debug?: unknown } = { failed: 0, checks: [] };
function check(name: string, pass: boolean) { result.checks.push({ name, pass }); if (!pass) result.failed++; }
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async (predicate: () => boolean, timeout = 15000) => { const started = performance.now(); while (!predicate()) { if (performance.now() - started > timeout) throw new Error("timeout"); await wait(30); } };
const viewport = () => document.querySelector(".git-graph-log") as HTMLElement;
const rows = () => [...document.querySelectorAll(".git-commit")] as HTMLElement[];
const requests = () => Number(document.getElementById("loaded")!.textContent!.replace("requests: ", ""));
const scrollBottom = async () => { const node = viewport(); node.scrollTop = node.scrollHeight; await wait(120); };
// headless 虚拟时间下没有持续的帧；轻微滚动触发组件的 rAF 与渲染步，IntersectionObserver 才会收到更新。
const nudge = async () => { const node = viewport(); node.scrollTop -= 4; await wait(120); node.scrollTop += 4; await wait(120); };
const summary = (row: HTMLElement) => row.querySelector(".git-commit-summary") as HTMLElement;
async function run() {
  await until(() => !!viewport() && rows().length > 0);
  check("initialRowsBounded", rows().length <= 40);
  check("loadedParentNotMarked", !rows()[0]!.textContent!.includes("（更早提交）"));
  check("ariaSetsize", rows()[0]!.getAttribute("aria-setsize") === "200");
  check("ariaPosinset", rows()[0]!.getAttribute("aria-posinset") === "1");
  result.viewportWidth = viewport().clientWidth;
  result.contentWidth = viewport().scrollWidth;
  check("horizontalScrollable", viewport().scrollWidth > viewport().clientWidth + 100);
  check("scrollLeftAvailable", viewport().scrollWidth - viewport().clientWidth > 100);
  viewport().scrollTop = viewport().scrollHeight; viewport().scrollLeft = viewport().scrollWidth; await wait(150);
  result.scrollLeft = viewport().scrollLeft;
  check("scrolledRight", viewport().scrollLeft > 100);
  const list = document.querySelector(".git-graph-body") as HTMLElement, sentinel = list.lastElementChild as HTMLElement;
  check("sentinelSpansContent", sentinel.getBoundingClientRect().width > viewport().clientWidth + 100);
  (document.getElementById("release") as HTMLButtonElement).click();
  await nudge();
  await until(() => requests() >= 1);
  await wait(150);
  check("horizontalObserverFires", requests() >= 1);
  check("rowsBoundedAfterPage", rows().length <= 60);
  check("ariaSetsizeAfterPage", rows()[0]!.getAttribute("aria-setsize") === "400");
  await scrollBottom(); (document.getElementById("more") as HTMLButtonElement).click();
  await nudge(); await wait(200); if (requests() < 2) { (document.getElementById("more") as HTMLButtonElement).click(); await nudge(); }
  await until(() => requests() >= 2); await wait(150);
  check("ariaSetsizeFinal", rows()[0]!.getAttribute("aria-setsize") === "405");
  check("rowsBoundedFinal", rows().length <= 60);
  await scrollBottom();
  check("offscreenParentMarked", document.body.textContent!.includes("（更早提交）"));
  viewport().scrollTop = 0; await wait(120);
  const beforeTotal = viewport().scrollHeight, beforeTop = rows()[1]!.getBoundingClientRect().top;
  summary(rows()[0]!).click(); await wait(450);
  const details = rows()[0]!.querySelector(".git-commit-details") as HTMLElement;
  check("expandHeight", viewport().scrollHeight > beforeTotal + 20);
  check("expandPushesRows", rows()[1]!.getBoundingClientRect().top > beforeTop + 20);
  check("detailsVisible", details.getBoundingClientRect().height > 20);
  summary(rows()[0]!).click(); await wait(450);
  check("collapseRestores", Math.abs(viewport().scrollHeight - beforeTotal) < 2);
  viewport().scrollTop = 0; await wait(120);
  const focused = rows()[0]!; summary(focused).focus(); await wait(50);
  viewport().scrollTop = viewport().scrollHeight; await wait(250);
  const active = document.activeElement as HTMLElement | null;
  const pinnedRow = document.querySelector(`.git-commit[data-commit-id="${focused.dataset.commitId}"]`) as HTMLElement | null;
  check("focusPinned", !!active && active.classList.contains("git-commit-summary") && active.closest(".git-commit") === pinnedRow);
  check("focusRowRendered", !!pinnedRow);
  check("focusPinnedInList", pinnedRow?.offsetParent === document.querySelector(".git-graph-body"));
  check("rowsBoundedWithFocus", rows().length <= 62);
  active?.blur(); await wait(100);
  viewport().scrollTop = 0; await wait(150);
  summary(rows()[0]!).click(); await wait(450);
  const initialDetails = (rows()[0]!.querySelector(".git-commit-details") as HTMLElement).getBoundingClientRect().height;
  await scrollBottom();
  const resizeTop = viewport().scrollTop;
  (document.getElementById("panel") as HTMLElement).style.width = "200px"; await wait(450);
  check("widthResizeRows", rows().length > 0);
  check("widthResizeScrollStable", Math.abs(viewport().scrollTop - resizeTop) < 160);
  viewport().scrollTop = 0; await wait(300);
  const resizedDetails = (rows()[0]!.querySelector(".git-commit-details") as HTMLElement).getBoundingClientRect().height;
  check("widthResizeExpanded", resizedDetails > 20);
  viewport().scrollTop = 0; await wait(250);
  summary(rows()[0]!).click(); await wait(400);
  // 窗口外展开行在高度变化后重新进入窗口必须重测：用 fixture 注入的内容高度变化代替宽度重排（本布局宽度由行内容决定）。
  viewport().scrollTop = 0; await wait(150);
  summary(rows()[0]!).click(); await wait(450);
  const baseDetails = (rows()[0]!.querySelector(".git-commit-details") as HTMLElement).getBoundingClientRect().height;
  await scrollBottom();
  (document.getElementById("panel") as HTMLElement).classList.add("extra-tall");
  await wait(150);
  viewport().scrollTop = 0; await wait(350);
  const tallDetails = (rows()[0]!.querySelector(".git-commit-details") as HTMLElement).getBoundingClientRect().height;
  check("reentryRemeasured", tallDetails > baseDetails + 20);
  await scrollBottom(); await wait(250);
  const tallCount = Number(rows()[0]!.getAttribute("aria-setsize"));
  check("reentryHeightAccounting", Math.abs(viewport().scrollHeight - (tallCount * 28 + tallDetails + 1)) < 3);
  viewport().scrollTop = 0; await wait(250);
  summary(rows()[0]!).click(); await wait(450);
  (document.getElementById("panel") as HTMLElement).classList.remove("extra-tall");
  await scrollBottom();
  const refreshBefore = viewport().scrollTop;
  (document.getElementById("short") as HTMLButtonElement).click(); await wait(300);
  const refreshMax = Math.max(0, viewport().scrollHeight - viewport().clientHeight);
  check("refreshNotEmpty", rows().length > 0 && !document.body.textContent!.includes("暂无提交"));
  check("refreshSetsize", rows()[0]!.getAttribute("aria-setsize") === "60");
  check("refreshScrollClamped", Math.abs(viewport().scrollTop - refreshMax) <= 1 && refreshBefore > refreshMax);
  check("refreshShowsTail", rows().some(row => row.getAttribute("aria-posinset") === "60"));
  (document.getElementById("empty") as HTMLButtonElement).click(); await wait(200);
  check("emptyState", document.body.textContent!.includes("暂无提交") && rows().length === 0);
  (document.getElementById("full") as HTMLButtonElement).click(); await wait(300);
  check("emptyThenFullRows", rows().length > 0);
  await scrollBottom();
  const restored = rows().map(row => Number(row.getAttribute("aria-posinset")));
  check("emptyThenFullScrolls", Math.max(...restored) >= 200 - 20);
  result.requests = requests();
}
setTimeout(() => {
  void run().catch(error => {
    const node = document.querySelector(".git-graph-log") as HTMLElement | null, sentinel = document.querySelector(".git-graph-body")?.lastElementChild as HTMLElement | null, first = document.querySelector(".git-commit") as HTMLElement | null;
    result.error = String(error && error.stack || error);
    result.debug = { requests: requests(), rows: rows().length, scrollTop: node?.scrollTop, scrollHeight: node?.scrollHeight, clientHeight: node?.clientHeight, setsize: first?.getAttribute("aria-setsize"), sentinelTop: sentinel?.getBoundingClientRect().top, sentinelWidth: sentinel?.getBoundingClientRect().width, viewportRect: node ? { top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom } : null };
  }).finally(() => {
    document.getElementById("result")!.textContent = btoa(JSON.stringify(result));
  });
}, 100);
