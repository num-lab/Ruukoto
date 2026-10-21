# 后台TUI重连提示增量独立审查

结论：无未解决阻断。此前分页、日志、关闭原键等UI审查结论继续有效。

此次只读检查queryMessage增量：离线和查询失败提示只由refresh写入；成功查询在同一会话/实例/代次核实后清除。停止、结束和日志结果继续由message保存，后续刷新不抹去操作结论；切会话同时重置两类提示。迟到查询仍由原代次核实拒绝，不会重新显示旧错误。

实际执行：npx tsx --test test/background-process-clients.test.ts；14/14通过，无跳过，146.517083ms。新增用例亲验离线提示出现、成功重连后消失，以及停止接纳提示经过再次刷新仍保留；同文件其余日志、导航、会话切换、关闭键用例一起通过。未运行监督器，未写主工作区。

## 被检内容 SHA-256

- `packages/tui/src/tui/background-processes.ts`：`d4c580b345ac463878c02a1b9759b3d4e6a743d2eb9ad62f6aeb7c834a31bb23`
- `test/background-process-clients.test.ts`：`86f4de3a4f79ba848f11ea7018b378c47fcdb9a0773d22977c72ef6462625050`
