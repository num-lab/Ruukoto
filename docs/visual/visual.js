// 图与表联动：悬停或聚焦带 data-k 的元素时，页面上所有同 data-k 的元素一起加 .hl。
for (const el of document.querySelectorAll("[data-k]")) {
  const set = (on) => () => {
    for (const x of document.querySelectorAll(`[data-k="${CSS.escape(el.dataset.k)}"]`)) x.classList.toggle("hl", on);
  };
  el.addEventListener("pointerenter", set(true));
  el.addEventListener("pointerleave", set(false));
  el.addEventListener("focusin", set(true));
  el.addEventListener("focusout", set(false));
}
