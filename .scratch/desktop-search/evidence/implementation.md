# Spotlight 实现与验收证据

## 对象与范围

日期 2026-10-21；实施基点 `7154f933b2e89b4bcc6007c5f26722ff53a5cbe8`，验收对象为本工作副本相对该基点的改动。要求与产品边界以[工单](../issues/01-spotlight-search.md)为准。检索保留 JSONL 唯一权威，不改 schema、不复制正文、不加依赖；协议升至 34。所有合成档案仅建在临时目录，未读取日常档案、未调用真实模型或 IM。

2026-10-21 最新导航决定已取代下文独立历史窗口、原消息定位高亮、只读 Composer 和「返回最新」的 renderer 检查及截图；这些内容仅保留为旧实现证据。当前所有搜索结果直接打开普通会话，本轮有效验证另记末节；后端检索、around／after 协议与合成性能证据继续有效。

## 工程检查

core／runtime／control 首批定向检查 60 项通过；view 浏览器可用性、旧命令、控制面、IPC、MyGo 与历史导航回归 138 项通过。检索来源竞态和阶段游标校验返工后，最终 core 检索 11 项通过；runtime／连续窗口 8 项通过。搜索控制器新增 7 项覆盖 IME、单在途、空页继续、迟到与失效、来源覆盖与标题未就绪；历史只读 Composer 与同 entry 多段 DOM 关联各有回归。

`test/43-desktop-demo.test.ts` 的冻结样式前缀断言失败：当前 `apps/desktop/src/renderer/style.css` 与本次基点 Git blob 完全相同，在字符 31712 处先于冻结 browser-toolbar 插入既有 terminal 样式。本次只新增独立 search.css，未修改冻结样式或降低断言；该失败单列为已有基线差异，不能记为通过。同文件工具摘要用例通过。

最终 `npm run check:static` 通过，包含全仓 lint、全部工作区与 foundation 类型、162 篇笔记、文档链接／源码引用／预算／段落门禁。最终 `npm run desktop:build`、`npm run desktop:mygo:build` 及两壳 `codesign --verify --deep --strict` 通过；制品为 Electron 44.7.2／darwin-arm64，同仓协议 34。相关最终功能回归一批 111 项通过，另新增同步 stat 兼容用例后 core 检索 11 项通过。

## 合成性能

环境为 Apple M5、macOS 27.0.1（Darwin 27.0.0）、Node v24.15.0、APFS／Apple Fabric，开发源版本为上文基点加本任务改动。冷索引表示没有派生索引，合成文件刚写入，文件系统缓存可能命中。单进程连续跑规模时 RSS 包含 Runtime、模型库初始化和前档遗留分配，不能把它解释为搜索新增内存。

[core 探针](implementation-probe.mjs)与[结果](implementation-probe-result.json)只测索引／扫描器及独立线程 socket／SQL 响应。[真实控制面探针](control-probe.mjs)经真实 Runtime、认证 Unix socket、参数转换、全会话身份筛选及摘要查询，并由独立线程持续交替发 ping／get_session。执行 `node --import tsx .scratch/desktop-search/evidence/control-probe.mjs`，每档首批与标题各重复 30 轮；末会话最后一条才有 needle。

| 控制面语料 | 冷索引到最后命中 | 热零命中完整扫描 | 热首批 p95（含 180ms debounce） | 标题列表 p95 | ping p95／max | 状态读取 p95／max | 进程采样峰值 RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 会话／1 万条／9.77 MiB | 454.32ms | 263.44ms | 186.02ms | 5.48ms | 6.19／12.71ms | 6.64／38.44ms | 653.89MiB |
| 1000 会话／10 万条／48.83 MiB | 8431.80ms | 5611.37ms | 255.12ms | 80.69ms | 46.33／90.97ms | 46.10／69.50ms | 836.19MiB |

完整数据见[控制面结果](control-probe-result.json)。增长规模没有放宽单批推进或并发延迟要求，也不要求全文在 3 秒内扫完；常用规模满足 ≤3 秒。首批 p95 是真正控制面结果页（含匹配）或可推进进度，不只测 spinner；查询词在常用与增长规模中广泛匹配。界面打开时已预取标题，renderer 的布局与焦点另验。

新阶段游标增加上下文校验后，单独重测最受影响的巨大记录：`node --import tsx .scratch/desktop-search/evidence/control-probe.mjs large-entry`。单条 8MiB，冷索引至命中 38.09ms／9 页、第一进度 1.69ms，热零命中 19.06ms、首批 p95 含 debounce 198.97ms、ping p95／max 13.69ms、状态 p95／max 14.63ms，独立进程采样峰值 RSS 574.78MiB。结果含后台源文件摘要，见[最终大条目结果](control-probe-large-entry-final.json)。未降低任何已确认阈值。

## 独立实现审查

`/root/navigation_audit` 独立审查索引与扫描实现，亲自复现并要求修正两项阻断：索引后让出时替换文件可返回新文件条目；新阶段游标越过 EOF 可被误判扫描完整。修复后原反例分别返回 history_changed、cursor_invalid；篡改长行准备进度跨过换行也拒绝。5 个并发冷索引与不同 limit／scanLimit 探针均终止、不重不漏；最终检索 10 项通过，结论为无未解决阻断。

`/root/search_gate_review` 独立审查 runtime、control、全范围摘要及 core 历史窗口，亲跑 8 项集成／窗口用例通过；核对普通宿主身份、存档与组织归属、旧调用分流、source 续读与实际内部报告绑定，结论为无未解决阻断。

`/root/search_ui` 独立审查 HistoryWindowState、CodeState 导航代次及提交守卫，亲跑 4 项 core 窗口、6 项搜索导航用例通过；核对连续页、来源失配、长正文、窗口外消息排除、同 entry 多流式段和迟到拒装，结论为未发现阻断。

UI 独立审查由 `/root/search_gate_review` 承担，发现候选未准备却报零命中、Tailwind 位移叠加、PA 页 Code 定位失败原因不可见、多结果带来源问题时底部操作越界四项。四项均已修正并亲验，58 项相关检查及最终 7 项控制器用例通过；1280×720、760×500、400×500 的 20 命中／5 来源问题场景中对话框四边至少 16px，底部加载操作可见。最终结论为无未解决阻断。

## 未覆盖与恢复条件

真实两壳的已验项与缺口见「隔离原生验收」和「搜索入口与开关调整」；MyGo 的完整键盘／焦点／滚动、两壳真实输入法与拥有者产品取舍仍待验收。没有使用真实个人档案、真实模型、IM、Linux／Node 22 矩阵，也未运行全量 npm run check；Go 源码未改，未另跑 Go race 检查。多条巨大正文的邻居会沿完整恢复规则补齐，增加传输和 renderer 内存；比 8MiB 更大的同步 JSON 仍须按同阈值重新验证，不以客户端超时遮掩后台阻塞。

## 真实 renderer 验证

使用 Playwright 独立后台 Chromium 155.0.0.0、真实 App 与 renderer 源码、临时合成 DesktopBridge，未连接日常后台；[桥接夹具](renderer-harness.js)、[入口](renderer-harness.html)、[Vite 配置](renderer-vite.config.mjs)可复制到 output/playwright 后按原文件名 spotlight-fixture.js、spotlight.html、spotlight-vite.config.mjs 启动 `npx vite --config output/playwright/spotlight-vite.config.mjs`，地址为 `http://127.0.0.1:4318/output/playwright/spotlight.html`。截图分别为[深色历史定位](renderer-history-dark.png)、[浅色窄窗搜索](renderer-search-light-narrow.png)。夹具只含 Alpha／Beta、普通／存档会话与收起执行记录中的「蓝色灯塔」。

亲验 ⌘K 自动聚焦 combobox，名称与正文分组、组织归属和已存档标记可见；Enter 后对话框完全退出，所属 trace 已展开，真实 data-entry-id=middle 取得焦点、CSS 关键词高亮存在，历史 banner 可见，提交表单为零。Esc 后焦点恢复原消息。预热标题后重复打开 20 次，打开加首组标题的 p95 为 24ms（样本 14–25ms），这是 renderer 证据，与控制面性能分开计算。浅色 760×500 下弹窗 x60／y24／w640／h203.22，四边保留空间；多命中场景另由独立审查验证。

独立上下文另验 PA 页 Code 定位失败反馈、视图保留，模拟 composition 中 Enter／Esc 不触发导航，组合结束后 Esc 关闭并恢复原 Ruukoto 按钮焦点。键盘辅助逻辑还覆盖首次遮罩、其他 Dialog 与终端 Ctrl+K；原生输入法不从模拟事件推定。最终独立新会话的唯一控制台资源错误是夹具未提供 favicon.ico；进入命中后额外监听 pageerror，结果为空。

额外协议回归最初在缺少脚本构建产物时有两项等待超时；执行 `npm run build:worker` 与 `npm run build:script` 后，`test/125-agent-wait-view.test.ts` 3／3 通过，独立复现也通过。构建产物目录由既有流程生成，不修改源代码或降低等待断言。

2026-10-21 界面精简：按拥有者截图反馈移除覆盖详情、常驻状态文字与重搜按钮，保留读屏播报、加载图标、加载更多与实际错误；此前截图及关于底部来源说明的视觉验收不再代表当前 UI，检索协议与性能证据仍有效。

本轮同时修正已有候选摘要刷新失败后关闭重开不能恢复的问题，新增最窄回归，搜索控制器 8／8 通过。`npm run check:static` 通过；最终恢复修改另经根与 Desktop 类型检查及定向 ESLint 通过。Electron／MyGo 重新构建成功，Electron 严格签名校验通过；独立复查确认恢复用例和界面删除无阻断。本轮未重验原生 UI。

## 直接打开普通会话的最终验证

拥有者最新反馈取代独立历史模式；名称和正文结果统一调用 openSession。renderer 窗口控制器、只读 Composer、提交守卫和定位高亮代码及专属测试已移除。`npm run check:static` 通过，`npx tsx --test test/desktop-search.test.ts test/41-desktop-stream.test.ts test/desktop-composer.test.ts test/desktop-inspector-tools.test.ts test/desktop-tool-activity.test.ts test/desktop-attachments.test.ts test/36-event-flow-state.test.ts test/37-view-browser.test.ts test/history-window.test.ts` 117／117 通过，覆盖正常恢复、草稿／附件、输入、消息投影及保留的后端协议；Electron／MyGo 重新构建和两壳严格签名校验通过。

Playwright 独立后台 Chromium 使用真实 App 和合成 DesktopBridge，运行[导航回归脚本](renderer-session-navigation-check.js)，[结果](renderer-session-navigation-result.json)通过名称打开、PA 上正文打开存档会话、普通可编辑输入与焦点、两个会话草稿、实时回复、Esc 焦点恢复及 Code 通知新标签。请求只读目标会话最新页，没有 around／after，也没有改变存档；无 pageerror。空搜索说明、「查看历史」栏、「返回最新」和只读输入提示均不存在。脚本等待 Dialog 关闭动画及其焦点回调后判定焦点，通知前以键盘关闭已有标签；不以瞬时关闭帧或悬停关闭键的鼠标命中作本次导航断言。

复现沿用上文 Vite 夹具启动方式；原夹具增加只供事件注入的 __spotlightReceive 接口，run-code 读取导航脚本全文执行。独立方案与实现审查由 /root/search_ui 承担，亲跑草稿／附件 1 项与搜索 8 项通过；文档事实由 /root/search_copy_review 复核。删除历史接线时发现通知分支残留前置 if，已恢复为原实现；审查者核对订阅及打开／关闭函数与基点逐字一致，浏览器另验证目标标签关闭后通知仍可新开。

本轮仍未启动原生 Electron／MyGo，原生输入法、焦点和主观体验待拥有者；无真实模型、IM 或日常档案访问。

2026-10-21 标题高亮间距修复：会话标题容器的 flex gap 把高亮前后文字视作独立项，查询 in 时 ping 显示两处 7px 间隙。标题高亮外增加一个内联 span，让完整标题作为单项，存档标签仍为相邻项。真实 App 的[几何回归](renderer-highlight-spacing-check.js)先红后绿，[测量结果](renderer-highlight-spacing-result.json)显示普通／存档标题间隙由 7px 降至 0px，正文始终为 0px；复现沿用上文夹具，脚本临时替换合成标题与正文为 ping。静态门禁和双壳构建通过，未重验原生界面。

2026-10-21 单行显示：会话名称、正文预览和来源行共用单行省略样式，去掉行内换行，存档 Badge 保持独立完整展示。[单行回归](renderer-single-line-check.js)在真实 App 中注入长中英文标题和含换行正文，1280／400px 两宽共 6 项检查通过单行高度、省略样式、真实裁剪、Badge 边界与无横向溢出；[结果](renderer-single-line-result.json)保留修复前多行和修复后测量。高亮间距回归仍为三类各 0px；探针兼容 Vite 编译后的引号与模块时间戳参数。静态门禁、双壳构建和独立局部审查通过，未重验原生界面。

2026-10-21 来源字段修复：上一版将会话名、工作区和时间作为整条文本省略，长名称会隐藏后两项；先前单行验证不足以证明字段可见。来源行拆成独立项，会话名和工作区平分可用空间并分别省略，时间及存档标记不收缩。原[单行回归](renderer-single-line-check.js)增强为逐字段检查：1280／400px 下两字段均至少 2em 可见宽度、时间等于完整 locale 字符串且未裁切、存档标记可见，并保留单行及无横向溢出断言；另验证时间和存档标记同时缺省。增强断言先红后绿，[结果](renderer-metadata-result.json)含字段宽度与时间原文。静态门禁、两壳构建及独立局部审查通过，原生界面仍未复验。

2026-10-21 最终正文结果布局：拥有者新参考图取代前述 snippet 在上、来源在下及完整时间常显的排版。上行会话名旁保留工作区和存档标记，下行单行 snippet，右侧独立显示相对时间；time 保留 ISO dateTime 和绝对日期 title。复用[单行回归](renderer-single-line-check.js)改验最终上下／左右关系，[结果](renderer-result-layout-result.json)覆盖 1280／400px、长中英文名称、换行正文、工作区和 Badge 可见、右侧 yesterday 完整显示，以及时间／Badge 缺省；[窄窗截图](renderer-result-layout-narrow.png)已实际查看。搜索测试 9／9 通过，新增相对时间的分钟／小时／日／月／年、未来及无效日期检查；月和年按 30／365 天近似。静态门禁及双壳构建通过，原生体验仍待拥有者。

## 隔离原生验收

2026-10-21 拥有者明确授权独立 Electron／MyGo 窗口、临时前台焦点及点击／输入／滚动。使用 macOS 27.0.1（26A434）、arm64、Electron 44.7.2 和本轮 MyGo 构建，连接[合成原生夹具](native-search-runtime.mjs)的真实 Code Runtime 与认证控制面：Alpha／Beta 两工作区、普通／存档两会话、160 条消息；模型响应器一旦被调用即失败。两壳使用独立 userData，未连接日常后台或档案。夹具控制目录采用 /tmp 短路径，避免 macOS Unix socket 路径长度导致 EINVAL。

加载更多按钮复用结果按钮的 mousedown.preventDefault，避免抢走搜索框焦点。[浏览器回归](renderer-load-more-focus-check.js)先红后绿：修复前点击后失焦，修复后正文 20→40 条、输入仍聚焦、方向键改变选中项、继续输入得到 needlex；临时日志 /tmp/spotlight-load-more-before.log 与 /tmp/spotlight-load-more-after.log。

真实 Electron 首次启动暴露既有 node-pty 构建问题：Vite 先解析依赖，现有 vendor 插件没有生效，原生加载器被内联后按 main 目录查找 pty.node。仅给 terminal-runtime 增加 enforce:pre；test/38-desktop-build.test.ts 使用实际配置插件做 write:false 的 Vite 构建，原配置外部引用为空，修复后精确引用 vendor 且不内联 loadNativeModule。最窄回归先红后绿，全文件 9／9 通过；独立只读审查确认无阻断。修复后的 desktop:build、check:static 和 codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app 通过；临时日志分别为 /tmp/spotlight-native-build-before.log、/tmp/spotlight-native-build-after.log、/tmp/spotlight-native-electron-rebuild.log、/tmp/spotlight-native-final-static.log。

Electron 使用实际应用窗口与生产 renderer，通过 CDP 驱动，未注入 DesktopBridge。⌘K 自动聚焦搜索；点击加载更多后选项 22→42（含两个名称结果），输入继续聚焦，方向键更新 aria-activedescendant，继续键入 x 得到 needlex；Esc 等关闭动画完成后恢复原「收起侧栏」按钮焦点。Enter 打开存档会话，普通「输入消息」框可编辑；PA 页面搜索中文正文后 Enter 切回对应 Code 会话，合成草稿可编辑，收起侧栏后 ⌘K 仍打开搜索。明暗主题均实际查看；滚动使 search-results.scrollTop 从 0 到 345，无诊断错误。[深色结果](native-electron-dark.jpg)、[浅色滚动结果](native-electron-light-wide.jpg)保留画面。独立重启时用临时 bootstrap 将 BrowserWindow 设为真实 760×500，[窄窗截图](native-electron-dark-narrow.jpg)显示弹窗 x60／y24／w640／h436、无横向溢出，名称／snippet 单行，工作区、存档标记和相对时间可见。

MyGo 连接同一合成后台，原生无障碍路径打开搜索、设置 needle 并读取结果，点击加载更多后实际读取 40 条正文。曾取得 1160×780 的真实截图并目视确认最终双行布局，另一次真实键入 x 经值回读确认 needlex；这两项不合并推定为完整分页后焦点通过。台前调度开启时，工具反复只绑定到 -1 或系统缩略窗口，截图、方向键与后续键入因窗口失效或 backgroundtype needs number window 被拒绝；重新绑定仅暂时恢复。分页动作虽曾返回 uncertain，但随后读到第 40 条，未重复未确认动作。未将窗口绑定失败当作产品故障，也未据此修改 MyGo。

A7 仍未全部通过：MyGo 完整快捷键／方向键／Enter／Esc／焦点恢复／滚动及两壳真实 IME composition 需后续补证；直接设置中文或 Unicode 键入不证明输入法组合阶段。MyGo 明暗／窄窗、两壳真实读屏与拥有者对片段辨认的主观产品验收也未覆盖。保留 ready-for-human，不把本次授权当作产品验收通过；最终未提交、推送或发布。

收尾：已关闭本轮独立 Electron／MyGo、合成 Runtime、Vite 与 spotlight-final 浏览器会话，未停止日常 MyGo。恢复原前台 Discord 时，GUI 工具要求额外的 Discord 应用访问授权；授权未获通过，工具明确要求本任务不再重试，因此自动恢复前台未完成，未读取 Discord 内容。

## 搜索入口与开关调整

2026-10-21 按拥有者新要求，搜索图标从侧栏菜单移到顶栏侧栏开关左侧；展开／收起均复用同一定位与位移规则，收起的搜索键／侧栏键为 x84／114，首标签从 x144 起，保留原生窗口控制空间。⌘K 切换搜索开关，忽略按键重复和组合输入；关闭继续走既有焦点恢复。搜索弹窗用独立 translate 居中，沿用 Dialog 的 fade 与 Y=-12px→0 位移，取消缩放；不静态声明 transform，避免 CSS 优化将居中合并进动画使用的 transform。

[真实 App 回归](renderer-search-controls-check.js)分别在开发样式和实际构建产物 CSS 下执行，后者先移除所有开发样式再安装 out/renderer/assets 中的 CSS。[结果](renderer-search-controls-result.json)各 10 项通过：动画 0／50／100% 的 x 均为 320，y 从 160.80 经 170.43 到 172.80；⌘K 关闭／恢复焦点、长按不反复开关、组合阶段不关闭、展开／收起／400px 窄窗布局、减少动画和其他模态窗口护栏均通过。受控负例还原旧 transform 居中、无纵移、快捷键只打开，并模拟旧搜索行位置，动画／⌘K／按钮位置共 5 项失败；没有改动源码运行负例。[截图](renderer-search-controls.png)已实际查看。搜索控制器测试 9／9、check:static、desktop:build、desktop:mygo:build、Electron 严格签名校验及 diff --check 通过；独立只读实现审查无阻断，并亲验 Safari16／Chrome124 的 CSS 压缩仍保留独立 translate。

本轮没有重新启动原生窗口；上节原生证据不覆盖本次改变的动画、⌘K 关闭和入口布局，其他未改行为的证据仍有效。真实 IME 不能由本轮 composition 事件模拟推定，原生验收缺口继续保留；未提交或推送。

## 聊天结果高亮与背景调整

2026-10-21 拥有者反馈 snippet 高亮未显示，要求去掉聊天内容结果的工作区名并将搜索弹窗改为灰色。根因是后端默认保留命中前 80 个字符，首个 mark 被单行 ellipsis 裁到可视区域外。只有正文预览使用 SearchHighlight 的 fromMatch：前文替换成一个省略号，匹配词紧接开头并保留完整后文；名称高亮保持全文，字面空格与 ASCII 折叠语义不变。删除消息结果的工作区元素及死样式，名称结果仍显示工作区；背景复用 --bg-surface，mark 文字使用 --text-primary。

增强既有[单行探针](renderer-single-line-check.js)，注入 80 字前文加 emoji 后才出现 needle 的 snippet，检查 mark 的左右边界实际位于预览框内；同时验证消息无工作区、名称结果仍有工作区，存档标记、相对时间、单行省略及可选字段保持。[结果](renderer-preview-result.json)记录修改前 1280px 场景的 markVisible=false／工作区未删除，修复后 1280／400px 两宽通过。每个视口重新加载并核实弹窗实宽分别为 640／368px，避免 resize 后采到旧布局。已实际查看[深色窄窗](renderer-preview-dark.png)与[浅色](renderer-preview-light.png)截图；浅色背景实测 oklch(0.97 0 0)，消息结果工作区元素为零。

搜索测试 9／9、check:static、双壳构建、两壳严格签名及 diff --check 通过；独立只读复核无阻断，另亲跑真实组件 SSR 的 6 组边界断言（长前文、emoji、大小写、字面空格、标题与空查询）通过。本次未启动原生窗口；旧原生截图不覆盖本轮预览与背景改动，原生输入法／读屏及 MyGo 完整交互缺口继续保留。未提交或推送。

## 预览居中与动态懒加载

2026-10-21 拥有者最新反馈取代上节 fromMatch 从匹配处开头展示及底部加载按钮。正文预览保留后端完整 snippet；SearchSnippet 用首个 mark 和容器实际像素宽度设置 scrollLeft，超宽时让高亮尽量居中，短消息保持从头显示，ResizeObserver 随宽度变化重算。正文使用 clip，标题仍用 ellipsis；实际截图发现 ellipsis 在横向定位后会隐藏本应绘制的高亮，改用 clip 后文字与高亮均可见。两种结果之间增加分隔线；滚动条固定宽度、静止透明，滚动中及停止后 700ms 显示。删除加载更多按钮，底部哨兵进入距滚动视口底部 80px 的范围时复用原分页器续查；每轮只触发一次，关闭、离线、组合输入、错误和扫描完成时停用。

真实 App、合成 DesktopBridge 和独立后台 Chromium 沿用上文 Vite 夹具，运行更新的[单行预览探针](renderer-single-line-check.js)与[自动分页探针](renderer-load-more-focus-check.js)。[合并结果](renderer-lazy-search-result.json)保留修改前失败与最终通过：旧预览 centered=false，旧分页有 6 项失败；最终 1280／400px 两宽的高亮可见、中心误差 ≤1px、单行、时间、存档标记和工作区字段规则均通过。同一个弹窗 400→1280→400 缩放后保持居中，scrollLeft 分别为 730／866；ping 搜索 in 保留完整 ping、scrollLeft=0。另移除开发样式后加载实际构建 CSS，在浅色主题重复预览、缩放和短消息检查，全部通过。已实际查看[深色预览](renderer-centered-preview-dark.png)、[生产 CSS 浅色预览](renderer-centered-preview-light.png)与[短消息](renderer-short-message-light.png)截图，确认实际文字和高亮绘制。

自动分页检查在 80ms 与仅 await Promise.resolve() 的快速应答下各 14 项通过：分隔线、无加载按钮、静止隐藏→滚动显条→停止隐藏、到达底部前不提前扫完、20→40→60 自动续载、单页在途、焦点和方向键保持、继续输入、关闭后取消 debounce、完成停止，以及分页错误保留结果且停止自动重试。错误与完成不凭列表仍可见而继续请求。合成响应只替换桥接数据，不替换被验收的 App 与搜索实现。

npm run check:static、npx tsx --test test/desktop-search.test.ts（9／9）、双壳构建、两壳 codesign --verify --deep --strict 与 git diff --check 通过。分页状态用例补充续载读屏提示，并先完成候选摘要，避免未就绪候选掩盖状态；最后夹具调整经定向 ESLint 通过。独立只读复核由 /root/navigation_audit 审查分页生命周期与竞态、/root/search_ui 审查预览像素定位与 clip，各亲跑搜索 9 项通过，无阻断；后者额外运行实际定位算法的短串、居中、左右边界和变宽 5 例自检。主代理再补快速响应与实际同页缩放证据。

本轮未重启原生 Electron／MyGo；上节原生截图与加载按钮的交互证据不覆盖本轮预览、滚动条和懒加载。两壳真实 IME／读屏、MyGo 完整键盘／焦点／滚动和拥有者主观验收缺口继续保留，工单仍为 ready-for-human。未提交或推送。

收尾已通过 check:docs，关闭 spotlight-lazy 浏览器会话及本轮 4318 Vite，移除本轮临时夹具与截图副本；验收脚本、合并 JSON 和截图留在本目录。未操作日常原生窗口或前台应用。
