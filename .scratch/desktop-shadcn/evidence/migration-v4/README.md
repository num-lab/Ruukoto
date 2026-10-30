# Desktop v4 同步验收

对应[迁移工单](../../issues/19-desktop-demo-v4.md)和[迁移决定](../../../../.agents/notes/implemented/architecture/2026-10-17-desktop-demo-v4.md)。验收机为 macOS Apple Silicon，MyGo v0.5.5；使用独立 QA bundle ID、profile、Code／PA 控制目录和临时工作区，未重启日常应用或后台，未提交或推送。

## 内容与来源

迁入 Ruukoto PA 单主会话、远程连接设置、主／右栏等宽自适应标签排序、真实仓库 Git graph 与提交详情，协议统一升至 v29。界面从 approved-demo-v4 冻结复制，正式端保留真实状态与权限边界。最终玻璃来源为 approved-demo-v4/src/style.css 加 approved-demo-v4-glass.css；app-window 共用唯一模糊底层，侧栏、两个顶栏与消息区圆角缺口透明露出同一层，主内容实色。approved-demo-v4-corner.css 和 approved-demo-v4-corner-glass.css 是未采用的中间尝试，不能用其图片证明最终效果。来源文件及生产文件哈希见 SHA256.json。

## 已执行检查

| 检查 | 结果与范围 |
| --- | --- |
| Desktop／MyGo／附件／PA／Git 定向组合 | 初次228项中227通过，test/41 文件因原 PA 空应答夹具触发异步失败；补齐真实形状后，41／v4／Inspector 组合44项全部通过，未把初次运行记成全绿 |
| PA／v4／Demo 来源／TUI／View／旧工作区组合 | 51项通过；当时存在 Vite HMR 端口占用提示，v4 SSR 随后禁用 HMR，定向来源检查5项通过 |
| reconnect pending 与 control seam | 50项通过 |
| Git 后端独立检查 | 11条真实临时仓库回归及45项相关组合通过；覆盖 merge、refs、worktree、非仓库、空仓库、环境注入、元数据保护、输出与时间上限 |
| npm run build | 通过，覆盖协议字段的 workspace 构建 |
| npm --prefix .scratch/desktop-shadcn/demo run check | 通过，最终 common glass 已包含；构建保留既有大于500kB chunk 提示 |
| cd apps/desktop/mygo && go test -race ./... | 通过 |
| npm run check:static | 通过；最后源码收尾再次检查通过，新增证据文档另跑 check:docs |
| npx tsx --test test/desktop-demo-v4.test.ts test/43-desktop-demo.test.ts | 5项全部通过，覆盖最后 HEAD 独立标记、PA 身份与冻结来源 |
| npm run desktop:mygo:build 与 npm run desktop:build | 均已通过；最终修正后重新构建并验证签名，输出保存在 logs，MyGo 与 Electron 的 codesign --verify --deep --strict 均退出0 |

没有把多组重复用例相加成独立测试总数。logs 中保留实际输出，首轮失败也保留。静态检查不代表原生交互验收。

## 原生与 Demo 证据

[native-fixture.mts](native-fixture.mts) 启动真实临时 Runtime／ControlServer，模型为本地确定性 MockModelServer，SSH 为只连接本机隔离 socket 的传输替身，不连接真实远端。ready.json 描述各次隔离环境；tasks.json 是实际后台任务记录；cleanup.json 核实临时进程与目录回收。系统 stderr 含 WebKit／输入法等提示，不声称日志完全无警告。

| 证据 | 已观察到的结果 |
| --- | --- |
| [Demo 连续玻璃](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fmigration-v4%2Fdemo-continuous-glass.png) | 当前 Demo 的侧栏、顶栏、圆角共同底层，取代旧分区玻璃证据 |
| [原生深色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fmigration-v4%2Fglass-first%2Fcontinuous-glass.png)、[原生浅色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fmigration-v4%2Fglass-first%2Fcontinuous-glass-light.png) | 相同 common glass CSS 在实际 MyGo 中呈现连续交界，圆角无额外矩形底板 |
| [PA 对话与排序](glass-first/pa-and-order.ax.txt)、[截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fmigration-v4%2Fglass-first%2Fpa-and-order.png) | PA 主会话读取真实历史；输入“最终 PA 回归”得到后台回显；Alt+Shift+Left 后保持焦点并播报第2位；PA 右栏仅浏览器和 SubAgent |
| [Git 提交详情](glass-first/git-details.ax.txt)、[截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fmigration-v4%2Fglass-first%2Fgit-details-light.png) | 真实4次提交含合并、branch／tag／remote；紧凑行和独立详情；非仓库无 graph 入口 |
| [连接设置](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fmigration-v4%2Fbefore-corner%2Fsettings-pa.png) | 真实隔离 host/controlDir 读写与重新连接；该图仅证明设置，不证明最终玻璃 |
| [最后构建的键盘排序](final/keyboard-order.ax.txt)、[截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fmigration-v4%2Ffinal%2Fcontinuous-glass-and-order.png) | 最后原生构建读取 mainSessionId，PA 标签从第3位改至第2位并保留活动项；包含 common glass 与 WebKit draggable 样式，先于最终 HEAD 独立徽标修正 |

## 未验证与产品验收

原生鼠标操作自动化返回 noWindowsAvailable，物理拖动、右栏拖动和原生窄窗口未能完成，不能记为通过；已有 Demo 交互证据和排序纯函数／对象身份回归仍有效，正式端另保留 Alt+Shift+方向键排序。未验证外部 SSH／真实模型、系统减少透明度开关、Linux 和真实 Electron 窗口；Electron 只做构建和签名。最终 HEAD 徽标修正以 SSR 回归与新构建验证，没有再启动一轮原生图。

工程实现与独立实现审查已完成，最后证据审查见工单。主观玻璃观感与上述原生拖动体验留待拥有者在新构建验收；协议 v29 需要桌面端和后台同步升级。Git 共享对象库及元数据链接／外部配置引用被明确拒绝，不能表示所有 Git 布局均支持。

最后独立复核由 desktop_v4_review 完成：亲跑 HEAD 独立徽标 SSR，核对新文档、14个本地证据链接、PA 任务和 AX、清理记录，无未解决实现阻断；其指出的冻结样式路径已改为 src/style.css。最终 MyGo／Electron 构建、签名和 check:docs 均通过，临时验收环境全部清理，具体输出见 logs 和 final/cleanup.json。
