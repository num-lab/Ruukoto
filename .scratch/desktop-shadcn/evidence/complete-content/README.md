# 完整内容验证

2026-10-18，macOS arm64 / Node 24.15.0。被检生产代码、测试与模块说明见 [SHA-256 清单](sources.sha256)。此前未提交的 Trace 和目录设备号调整保留；本轮审查只覆盖工单 26 的增量。

## 工程验收

- `npx tsx --test test/34-event-stream-backend.test.ts test/36-event-flow-state.test.ts test/desktop-workspace-files.test.ts test/dir-identity.test.ts test/desktop-live-files.test.ts test/desktop-inspector-tools.test.ts`：最终 107/107 通过，零跳过。包含超过 1 MiB 的多字节思考与文件、UTF-16 代理对跨 provider 更新、分页修订和来源漂移、短页、关闭及离线停止续页、文本/图片内存异常与恢复。
- `npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/12-reconnect-pending.test.ts test/66-control-seam.test.ts test/94-task-ending.test.ts test/37-view-browser.test.ts test/38-desktop-main.test.ts test/38-desktop-personal.test.ts test/38-desktop-build.test.ts test/39-desktop-recovery-guide.test.ts test/40-desktop-creation.test.ts test/41-desktop-stream.test.ts test/42-desktop-inspector.test.ts test/43-desktop-demo.test.ts test/desktop-tool-activity.test.ts`：236/236 通过，零跳过。之后只修正空思考元数据覆盖待补块及预览内存错误，受影响逻辑在最终 107 项中重验。
- `npm run check:static`：退出 0；最终协议版本说明改为 32 后 `npm run check:docs` 再次退出 0。
- `npm --prefix .scratch/desktop-shadcn/demo run check`：退出 0；`npm run desktop:build` 与 `npm run desktop:mygo:build` 最终构建均退出 0。Electron 和 MyGo app 的 `codesign --verify --deep --strict` 通过。
- `git diff --check` 通过。

真实 SDK 事件测试使用本地模拟 provider 和真实控制面/工具，夹具 contextWindow 为 200 万，避免超长传输检查被上下文预算提前中断；生产上下文预算不变。界面请求/文件读取使用真实临时文件及可控 wire 响应，不调用真实模型。

## 独立审查与反例

reasoning_preview_plan_review 独立方案审查和最终实现审查无剩余阻断，亲验投影/分页/生命周期 56 项、空元数据与图片内存异常修正 3 项，最后对快照/工作区 × 图片/文本四条内存失败与重试再次 4/4 通过。隔离临时副本恢复原 Driver 截断后，真实 SDK 完整思考断言失败。空元数据覆盖待补正文的回归在修复前亲验得到 `a` 而非 `ab`，修复后通过。preview_scroll_audit 在独立临时副本编写两份预览测试，父代理审查应用；未并行改共享检出。

## 浏览器验收

[浏览器夹具](browser-fixture.mts)使用实际 Desktop ToolActivity、EventFlow、FilePreview 与实际 Demo ToolActivity。控制数据用于验证组件，不把它记作日常 MyGo 进程或真实模型验收。明暗模式均验证新增内容后六行容器滚底；[DOM 测量](browser-metrics.json)中初始高度 134px、行高 22.4px，追加后内部 scrollHeight 从 538 增为 1030、1523，scrollTop 分别为 896、1388.5。主区域分别保持 0 与手动操作后的 54，不由内部跟随改变；历史区追加文本前后仍为 scrollTop 0。

文件预览包含 1,260,146 个字符，末尾 `FILE_PREVIEW_END_完整末尾` 完整存在；固定预览区高度 734px，scrollHeight 2923px，滚动至 2189px 后末尾可见。截图：[流式跟随](scrolling.png)、[文件末尾](file-preview.png)。

未重启日常后台或桌面进程，未调用真实模型，未跑全仓检查或 Linux 平台矩阵。协议 32 需要桌面和后台共同升级；旧版已截掉的展示前文不自动恢复。取消总量限制后内存、字符串容量、源码高亮和全量 DOM 的成本随内容增长，未增加大文件虚拟化。
