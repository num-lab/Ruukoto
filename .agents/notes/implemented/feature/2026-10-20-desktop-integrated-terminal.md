# Agent Note: 桌面右栏集成终端

Status: implemented

## 问题

右栏需要拥有者直接操作的本机终端，多个实例可在不同工作区运行。它的执行归属与后台 Agent 任务不同，关闭标签必须结束对应进程，切换右栏、会话或 Personal 不能误当成关闭。Electron 和 MyGo 使用同一份界面与 Node 宿主。

## 决定

DesktopHost 持有 TerminalManager；终端操作只向 Code 开放，不进入控制面，不保存终端历史。宿主用已安装的 Code 快照与项目事件登记工作区根，打开请求携带程序生成的终端引用、预期数据实例与工作区引用；宿主重新核实真实路径和 inode，以根目录为 cwd 启动默认 shell。开始过环境准备与回收等待后再次核实代次，旧实例不能启动新终端。

node-pty 1.1.0 使用 N-API，同平台 Node 与 Electron 共用二进制。两种应用 vendor runtime JS、许可证和本平台 pty.node；macOS 另含 spawn-helper，显式保留执行位。Electron 解包 native/helper，MyGo resources 保持目录结构。生产检查仅允许精确终端 vendor 引用，其他 workspace 与动态外部依赖仍拒绝。

终端最多8个；输出16ms合并、每帧最多64KiB、pending达到64KiB暂停PTY，积压发送每帧间隔16ms，发送完成后恢复读取；MyGo等待管道写入完成。输出先于退出帧。App 的单订阅按终端引用分流，output直接写xterm而不重绘React；所有Code终端常驻，隐藏只停止布局与输入，中文按UTF-8字节写入。xterm保留5000行滚动历史，显示时FitAddon更新尺寸，主题跟随应用，明暗各提供完整ANSI 16色；字体必须写具体等宽字体栈（与全局`--font-mono`同值），因为xterm用OffscreenCanvas的`ctx.font`测量字符尺寸，canvas字体语法不解析`var()`，CSS变量会静默回退默认比例字体并同时压错行高；颜色与字体样式经xterm运行时注入的`<style>`元素交付，依赖桌面CSP对`style-src`放行`'unsafe-inline'`（脚本仍保持nonce与来源限定）。Ctrl组合透传shell；每终端输入与尺寸请求串行，前次失败后停止后续发送，避免MyGo异步绑定乱序。

关闭终端、所属会话、换数据实例、页面重载／崩溃或宿主退出时回收。停止前按ps核实shell与后代进程组，拒绝与宿主重叠的组，先TERM，500ms后KILL并检查仍可执行成员；即使shell先退出也保留升级。停止失败保留宿主记录和界面提示，提供重试回收入口，不能声称整个终端已经回收。迟到的打开成功应答在标签已关闭时再次回收。

## 既有决定

检索desktop、MyGo与终端：本篇与[MyGo外壳](../../implemented/architecture/2026-10-17-desktop-mygo-experiment.md)、[本机文档预览](2026-10-17-desktop-local-browser.md)部分重叠，只扩展本机宿主能力与原生打包，原有连接、预览与网页隔离继续适用；[任务与终端分离](../../implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md)继续约束后台任务，不被本机交互终端取代。其他命中为demo或后台执行决定，与本篇无关。

## 备选方案

- 通过后台工具或控制协议运行shell：可复用任务监督，但终端将依赖后台连接和Agent执行身份，无法表达拥有者独立的本机交互终端。
- 把node-pty全部打成单文件：可延续纯JS产物规则，但动态native加载和spawn-helper依赖相对目录；保留库的runtime目录比改写加载器更小且可直接验证。
- 只杀PTY shell PID：调用简单，但交互前台作业可在不同进程组，shell退出后忽略信号的作业仍存活；必须捕获后代进程组并保留升级回收。
- 每个终端独立订阅宿主：接线局部，但现有subscribe会触发连接初始化，输出也会重复进入整个应用；复用App单订阅分流。
- CSP 保持样式不放行内联：策略更纯，但xterm的颜色、字体与光标规则全在运行时注入的style元素里，拦截后终端既无颜色也量错字符尺寸；改用nonce需改造xterm注入路径或自建样式管线，代价远超放行内联样式（脚本仍受nonce与来源限定，风险增量限于样式注入）。

## 后果

两种外壳使用相同PTY语义与界面，多实例不受右栏切换影响；增加native和helper制品，构建与签名必须覆盖。终端以应用账户执行，工作区仅限制启动cwd，shell可访问该账户可访问的其他目录，不是Agent沙箱。主动脱离或在回收前已经成为孤儿的进程无法保证追回；进程表快照也不能封锁回收期间新派生的外部进程。终端非持久化，重载与退出丢失滚动历史；高速输出有界读取与发送节流，但Electron到xterm的传输没有消费应答。真实外壳的输入法、选择、明暗和隐藏恢复需独立体验证据，离线测试不代替。
