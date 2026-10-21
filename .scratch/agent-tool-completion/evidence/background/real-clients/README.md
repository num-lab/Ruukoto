# 真实 TUI / Electron 会话后台验收

2026-10-21，macOS arm64，Node 24.15.0。`probe.mts`只读主仓库模块，在独立临时档案运行完整Runtime、ControlServer、真实工具worker与macOS监督器；模型HTTP端点使用离线替身。后台由实际`runtime.submit`→模型工具调用→`process_start`启动真实HTTP服务；没有直接伪造后台record、替换管理器或注入客户端bridge。随机stdout/stderr token只由后台启动时产生，command不含token，客户端看到token才能证明读到了实际日志。

## 最终通过证据

| 目录 | 实际覆盖 |
| --- | --- |
| `final-tui/` | Python标准库真实PTY运行`apps/ruukoto-code/src/main.ts tui --session ...`，菜单进入后台清单、读stdout和stderr、请求单停、退出TUI后保留HTTP服务与目录占用、重连后确认“结束本会话后台”。动作均经真实控制面；断言stopVerified、HTTP拒绝连接、占用清空与关闭记录落盘。额外断言连接恢复不残留offline提示，单停结果不残留“正在登记停止”，结束显示“本次结束请求涉及的后台已核实停止。”。三个PTY退出均为0、无cleanupError并离开alternate screen。原始ANSI、输入时间线和完整driver JSON均保存。 |
| `electron4/` | 从最终`apps/desktop/out`复制至临时目录，仅在复制件给BrowserWindow加`show:false`，使用真实Electron、preload/IPC/主进程ControlClient与真实Runtime；CDP发鼠标按下/抬起操作DOM中的实际控件。会话菜单→后台清单→stdout/stderr随机token→单停；退出整个Electron后后台仍能HTTP响应且占用保持；新Electron连同一Runtime后确认结束，得到真实关闭记录、stopVerified、HTTP断开和占用清空。三次Electron均以0退出。PNG及同期DOM文本可逐项核对，已亲自查看stdout与结束后截图。 |

每个最终目录保存`manifest.json`、`processes.json`、`control-calls.json`、分步状态与`cleanup.json`；`runtime-profile/`保留本次SQLite、JSONL和日志副本。`electron4/artifact-sha256.json`固定实际worker、监督器、主进程与renderer产物。`final-tui/source-sha256.json`固定最终TUI及实际Runtime/control/worker内容，根`final-source-sha256.json`是收尾复核。运行只用了新生成的隔离凭据，没有业务凭据。

验收完成后，主代理仅把两端确认说明从“登记停止屏障...”改为“停止并核实本次结束请求涉及的后台；保留会话和历史。”；按钮和行为未改。上述SHA与截图固定的是此次实际检验内容，后续文案和对应重建未冒充同一个产物，也未重跑进程链。

`cleanup-verification.json`独立复核本轮及失败尝试共12个fixture PID均不存在，全部HTTP URL拒绝连接。临时Runtime均正常stop，两个交互式探针随后发送EOF退出0；没有留下本次Electron或探针进程。没有终止其他进程。

## 失败尝试与修复来源

根目录最初一次探针局部变量遮蔽`process`导致ReferenceError，尚未启动后台。其后根目录第一次全链真实TUI动作已成功，但探针要求精确结束消息的断言失败，保留了原始输出与清理状态；`attempt2/`放宽该断言后实际操作通过，同时证明当时产品仍残留offline和“正在登记停止”提示。主代理据此修复TUI查询提示与动作结果归属；`final-tui/`恢复精确断言并通过。

`electron/`继承宿主`ELECTRON_RUN_AS_NODE=1`而未进入GUI；脚本去掉该环境变量。`electron2/`用DOM.click不能触发Radix菜单的pointer交互；改发真实CDP鼠标事件。`electron3/`已完成日志、单停和退出保留，但菜单关闭动画期间探针选中残留菜单项而未发关闭请求；最终把菜单后的操作限定当前dialog并等可见，`electron4/`整链通过。这些尝试的失败与cleanup保持原样；不把自动化错误当作产品失败。

## 复现

在主仓库根执行`RK_CLIENT_PROOF_DIR=/tmp/自行选择一个新目录 node node_modules/tsx/dist/cli.mjs /tmp/ruukoto-bg-real-clients-20261021/probe.mts`。三轮TUI通过后输出`TUI_PASSED_WAITING_ELECTRON`；输入`electron`继续桌面，输入`end`只收齐TUI。若使用交互PTY，之后发送EOF释放父探针stdin。只跑桌面时另加`RK_SKIP_TUI=1`。脚本不下载依赖，也不写主仓库。

本证据证明真实客户端到真实执行进程的行为，模型仍是mock；没有重跑DeepSeek、真实browser工具、真实业务接口或Linux客户端。它不取代macOS停止身份专项、Linux平台及真实模型证据。
