Status: needs-triage

# 04 — 写到一半的崩溃后，pi 补换行使会话历史被判为损坏

**What to fix:** 后台在写会话 JSONL 的一行时崩溃，重启后要能正常读出崩溃前已完整写入的历史，不能把整份历史判为 `history_corrupt`。

## 现状与证据

- **ruukoto 的严格解析**：`src/core/history.ts` 的 `parseSessionFileStrict` 把文件尾部没有换行的半行当作「部分记录」排除；但凡是以 `\n` 结尾、却解析失败的完整行，一律抛 `history_corrupt`。
- **pi SDK 的修复行为**：`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` 的 `loadEntriesFromFile` 逐行解析，跳过解析失败的行。读完后只要尾部还有未换行的内容（`pending` 非空），就 `appendFileSync(file, "\n")`，并不看这段内容能否解析。
- **两者叠加的结果**：
  1. 崩溃发生在一行 JSON 写到一半时，文件尾部留下半行。
  2. 重启后 Driver 重建 SDK 会话，pi 打开这个文件，给半行补上换行。
  3. 这半行于是变成「以换行结尾、解析失败的完整行」，ruukoto 此后每次严格解析这个文件（历史读取、任务完成时的 `verifyAndLinkHistory`）都报 `history_corrupt`。
  4. 可见后果：任务以 `history_corrupted` 中断；TUI 读不出这个会话的历史。
- **对照**：ADR 0001 与 storage-layout.html 都写着「尾部半行不算完整消息」。这个约定在 pi 修复之后失效。

来源：2026-10-03 可视化文档核查（storage-layout.html）。主代理读了两侧的代码并确认了上述行为，没有用真实崩溃复现。

## 待决定（triage）

可选方向，需要拥有者或维护者选定：

1. **在 pi 打开文件之前，由 ruukoto 自己修复尾部。** 例如把不完整的尾部半行截掉或移到旁路文件，并记录事件。改动集中在宿主，但要确定修复时机，防止与 pi 的写入竞争。
2. **放宽严格解析。** 只对「文件最后一个完整行」容忍解析失败，按部分记录处理并记事件；文件中间的损坏行仍报错。改动小，但会削弱损坏检测。
3. **向上游 pi 提议**：遇到不可解析的尾部时不补换行，或改成截断。依赖外部。

## 验收标准（选定方向后补充细化）

- [ ] 用测试构造「最后一行写到一半」的会话文件，经过一次 SDK 重开之后，历史读取与任务完成核对的行为符合选定方案，崩溃前已完整写入的消息全部可读。
- [ ] 文件中间的损坏行仍报 `history_corrupt`，不被静默跳过。
- [ ] 同步 ADR 0001 / storage-layout.html「三份权威来源」一节里关于尾部半行的说法。
