import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../demo/src/app.tsx";
import "../../demo/src/style.css";

function Fixture() {
  useEffect(() => {
    const measure = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>('button[aria-label="收起侧栏"]');
      if (!button) return;
      const before = button.getBoundingClientRect().left;
      const started = performance.now();
      const frames: { time: number; left: number }[] = [];
      const sample = (time: number) => {
        const current = document.querySelector<HTMLElement>('button[aria-label="展开侧栏"]');
        if (current) frames.push({ time: time - started, left: current.getBoundingClientRect().left });
        if (time - started < 260) requestAnimationFrame(sample);
        else document.querySelector("#sidebar-measurement")!.textContent = JSON.stringify({ before, frames, pass: frames.length > 0 && frames.every(frame => frame.left <= before + 1) });
      };
      requestAnimationFrame(sample);
    };
    document.addEventListener("click", measure, true);
    return () => document.removeEventListener("click", measure, true);
  }, []);
  return <><App /><output id="sidebar-measurement" role="status" style={{ position: "fixed", bottom: 0, fontSize: 9, maxHeight: 40, overflow: "hidden", background: "#111", color: "#eee", zIndex: 100 }} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
