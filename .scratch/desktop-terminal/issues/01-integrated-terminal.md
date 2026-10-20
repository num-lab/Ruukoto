# 01 集成终端实现

Status: in-review

## 目标与边界

右栏新标签页提供「终端」入口，打开后创建 PTY 终端；多个终端实例并存，各自可绑定不同工作区根目录为 cwd；关闭标签销毁终端进程；Electron 与 MyGo 双外壳可用。

## 方案

1. 依赖与构建链：node-pty@^1.1.0（N-API，Electron/Node 共用同平台二进制）、@xterm/xterm@^6.0.0、@xterm/addon-fit@^0.11.0；两外壳 vendor node-pty 的 runtime JS、许可证与本平台 pty.node／spawn-helper，保留 helper 执行位；check-build 只允许精确 vendor 引用并核实原生产约束；Electron 解包 native/helper，MyGo resources 包含 vendor。
2. IPC 契约：bridge.ts 增 `DesktopTerminalUpdate`（output/exit 帧，base64）与 DesktopBridge 四方法；preload 转发 `desktop_terminal_open/input/resize/kill` op；ipc.ts handleRequest 仅放行四个明确本地 op；host.request 本地分支调 TerminalManager。
3. 主进程 TerminalManager：PtyFactory 构造注入；open 接受程序生成的预期 instance_id 与已安装 Code 快照中的 workspace_id，由宿主核实 rootDir 真实身份后选择 cwd；输出 16ms 合并、单帧 ≤64KiB；回收当前可追踪后代的进程组，TERM→500ms→KILL，不因 shell 提前退出取消升级；上限 8；close() 全销毁；Personal target 拒绝。换实例、渲染进程重新订阅或崩溃回收旧终端；主动脱离、回收前已成为孤儿的外部进程不保证回收。
4. renderer：inspector.ts 增 terminal 标签类型与 openTerminal；新 terminal-panel.tsx（xterm + FitAddon + ResizeObserver；沿用 App 单订阅分流，不因输出重绘 React）；全部 Code 终端常驻，切换标签、会话、Personal 或收起右栏保留；新标签页选择工作区；关闭会话或终端标签回收；中文按字节写入，Ctrl 组合透传终端；每终端 input/resize 串行，失败后停止后续发送，回收失败持续展示并提供重试。
5. 测试：`test/desktop-terminal.test.ts`，fake pty 注入、真实 node-pty（不可跳过）、交互前台作业回收、双壳隔离 vendor spawn；构建与既有 IPC／检查器回归。

## 进展与交接

- 2026-10-20：开始实施，按上述顺序推进。
- 2026-10-20：接手核实拥有者已确认范围，独立方案审查要求补齐 spawn-helper、runtime JS、进程组回收、渲染生命周期及必跑 PTY；这些属于实现修正，保持原目标。当轮已进入实施，原目标保持。

- 2026-10-20：实现与文档完成；独立首轮审查发现 MyGo 输入乱序、回收失败不可见，已修复并配回归。最新相关139项、静态检查、根构建、双壳构建／签名与包内PTY启动均通过。返工复审因独立审查服务错误尚未获得结论，下一角色为独立审查者，随后为拥有者体验验收；拥有者已授权提交当前实现；未推送，工单继续保持待复审。

## 验收与证据

工程验收：多终端不同工作区、输入／输出／resize、参数与工作区拒绝、8 实例限制、TERM/KILL、同实例恢复及换实例／重载回收、双壳打包与签名。产品验收：真实 Electron 与 MyGo 检查明暗、输入法、快捷键、隐藏恢复及尺寸变化；缺实机证据保留待人工验收。

[验证记录](../evidence/README.md)持有实际命令、日志、包内启动结果和限制。当前工程检查通过，但独立实现复审未完成，不记工程验收通过；产品验收缺两壳真实终端的输入法、Ctrl组合、明暗、隐藏恢复与尺寸变化。恢复条件：独立审查服务可用后只复核已修两处及受影响范围；使用证据目录native-fixture重新启动隔离双壳验收，按工作区和标签观察实例保留／回收。
