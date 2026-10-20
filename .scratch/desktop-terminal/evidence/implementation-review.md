结论：**有两项阻断，需返实施者修复。** 全程只读，已忽略原有 `.gitignore` 修改。

1. **[P1｜需求轴] MyGo 不能保证终端输入顺序。**
   [terminal-panel.tsx:37](/Users/eitrous/Developer/ruukoto/apps/desktop/src/renderer/terminal-panel.tsx:37) 连续并发发送输入，[preload.js:18](/Users/eitrous/Developer/ruukoto/apps/desktop/mygo/preload.js:18) 直接转发；MyGo 每次调用独立运行，传输写锁也不保证先后顺序。亲自执行当前 preload 的受控调度反例，依次输入 `a`、`b`，第二次调用先执行时结果为 `ba`。应按终端串行发送并补回归；此反例尚未在真实 MyGo 窗口复现。

2. **[P2｜规范轴] 关闭后的回收失败对用户不可见。**
   [inspector.ts:157](/Users/eitrous/Developer/ruukoto/apps/desktop/src/renderer/inspector.ts:157) 只把失败写入 `workError`，整个 renderer 没有界面消费者。亲自注入 `terminal_stop_failed` 后关闭标签：标签消失，错误没有展示，命令可能继续运行。违反错误处理规范的“状态未知必须可见”；需展示失败并保留核实或重试入口。

检查证据：

- 内存断言通过：宿主等待环境期间取消、重置、关闭、换实例均阻止迟到 PTY；64KiB 分帧、中文完整性和尾输出先于退出通知。
- 常驻隐藏、稳定组件身份及单订阅分流未发现其他明确阻断；核心源码哈希在审查期间未变，新增宿主竞态测试已复核。
- 指定测试因沙箱受限未完成：`npx tsx` 创建 socket 报 `EPERM`；替代入口执行时 **5 项通过、14 项因临时目录权限失败**，不能记为通过。
- 现存双壳包签名验证通过；Electron 包内 PTY 实际启动成功。旧包不能证明最新源码构建通过。

未覆盖：最新双壳完整构建、真实 shell／前台作业回收（`ps` 被拒绝），以及实机输入法、快捷键、明暗和隐藏恢复；这些仍需验收。
