# 测试精简补充独立只读审查：Personal 与 Desktop

审查者：audit_remaining。对应28c033f7；当前主工作区有拥有者工单更新，不是本审查写入。严格按personal-*及desktop-*前缀发现86个.test.ts，另复核38-desktop-personal.test.ts，共87个文件。本报告只读代码、用例和既有决定，不跑测试、计时或浏览器，不修改主工作区。首份报告在remaining.md。

## 结论

现行Personal除工单首批的Pi版本重复、命令模式副本以及自动审查/损坏准备外，未发现可以直接删除、且已有同边界承接的额外明显冗余。不能把主/子/定时来源、工具先验与实际payload边界、真正SIGKILL与可控错误、网页/远端效果与进程停止等独有保护按相似标题合并。主要新增机会是Desktop的重复Runtime/Host准备；以下降层保留全部原分支断言，而不是skip或删除独有负例。

## desktop-session-settings：30次Runtime准备可降层

fixture(18–49)每次建两个目录、启动MockModelServer、Runtime、ControlServer、认证ControlClient，再通过handleRequest驱动CodeState。52行四模式×四入口展开16条；全文件共30条，每条重新启动上述资源，且这些创建测试并未需要实际模型响应。此数是源码展开，不是计时结果。

| 位置与标题 | 建议 | 独有断言/保留边界 |
| --- | --- | --- |
| 52 Desktop新会话保留mode/model/effort：四模式×new-session/existing-workspace/new-workspace/last-tab-closed | renderer完整16格改用现有fakeSnapshot/DesktopBridge；无需通用新框架 | 当前/最近来源、关闭最后标签、跨工作区传递、model与thinkingLevel复制、四模式传参均保留。真实控制面至少覆盖create_session/open_workspace两种op的设置提交和后台落盘；如合并成功准备，仍实际覆盖四种mode的持久结果，不能只有mock回显。 |
| 70 源设置saving/unknown时不创建 | 降层 | 两类状态都零create/open请求、当前会话保持；saving有真实未解决Promise后才释放。 |
| 87 未知降权不能被恢复队列覆盖，快照核实后继承后台实际模式 | 保留真实集成 | 后台已confirm而前端仍full_access；resume不能清除unknown；真实快照恢复后新会话确实confirm。仅mock前端无法证明降权保存。 |
| 117 换实例后同ID的saving/unknown设置不拦创建 | 降层 | 两状态、同ID不同instance、旧异步应答不影响新实例。 |
| 134 创建重试固定首次克隆设置 | renderer降层，幂等后台由180承接 | 首次结果unknown后改变来源对象；两次发送参数完全相同，不因对象引用改变mode/model/effort。 |
| 153 关闭Code标签后按同实例快照最新值继承 | 降层 | 同实例刷新更新最近来源；当前Code选择优先于另一个会话最近修改。 |
| 167 换数据实例清除Code来源，未选择时后台默认 | 前端重置/参数省略可降层；保留真实省略参数默认验证 | 不再发送旧mode/model_selection；真实新会话为confirm和后台默认模型。 |
| 180 初始设置open_workspace/create_session：首次成果优先 | 两个op均保留真实控制面/存储 | 首次创建后修改设置，原键带失效模型重放仍取首次会话当前值，事件序列不增长；不覆盖后来选择。 |
| 194 初始设置两op：无效显式模型/模式不创建 | 保留真实负例 | 两种op、model_not_found/invalid_params分别拒绝，sessions/projects/events全不变。 |
| 206 Desktop存档隐藏/取消存档恢复 | 两条合为同夹具归档→取消归档 | 当前archived=false分支没有先归档，仅证明初始false不变。顺序执行true再false，分别核实工作区列表、归档列表、其他会话不变、后台archivedAt及零Task，才真正证明恢复。 |

依据：.agents/notes/implemented/feature/2026-10-17-session-creation-settings.md。初始mode/model与session.created同事务保存；重放优先首次成果；设置未知阻止恢复队列是权限事实，不仅UI偏好。源码CodeState.create:328–338统一克隆参数，模式×入口矩阵的renderer部分不需要30个后台。

## 可直接裁剪的其他明确冗余

| 位置与标题 | 操作 | 承接/原因 |
| --- | --- | --- |
| desktop-git-layout:22 Demo70000条布局不展开函数参数 | 删除 | 只执行.scratch/demo参考算法，未执行正式模块。39正式buildGitGraph的70000条/窗口/尾部行为保留。 |
| desktop-git-layout:31 Demo追加页面保留前缀lane、合并与更早父边 | 删除 | 只测试Demo本身。52正式模型对独立参考逐行等价、75正式增量与全量一致及续行变实线保留。不可因删Demo专用用例而删52独立参考对照。 |
| desktop-browser-documents:38 本机URL在Desktop与Demo规范化 | 去掉demo import及Demo循环副本 | 正式browserAddress的全部输入表保留，包括远端file主机、编码分隔符、NUL、query、根目录等拒绝；Demo不是正式调用方。 |

这几处低成本删除不支持任何具体墙钟收益承诺。

## desktop-settings-skills 的额外降层机会

此文件fixture:19–58每次实际启动Runtime、认证控制面、DesktopHost及环境接管。建议154、164、179、195、208、219的renderer状态与展示改用已有DesktopBridge入口，保留原案例，而不是新增测试框架。

| 位置与标题 | 可降低的准备 | 仍需保留的事实 |
| --- | --- | --- |
| 154 重新选择取消或预览失败后旧预览只供比较 | 内存选择结果和错误 | previewStale、零导入、旧预览保留不可提交。 |
| 164 已选第51项刷新首屏后仍可启停移除 | 用两页响应代替50个真实外部SKILL目录 | 50项首屏、隐藏选中项的完整detail、第二页与新revision冲突、原列表保留；不能简单删第51项场景。共享managed-skills:246持有列表有界/单项详情，61持有真实启停和移除。 |
| 179 在途断线与迟到应答保留原关联 | 内存gate/instance上下文 | 原pending跨离线保持；换实例不读写；回原实例核实；旧读取迟到不安装。 |
| 195 启停和移除丢答均读回原身份 | 可控Bridge的unknown与后续详情 | 隐藏removed仍按ID核实，原正文可查，每项写只发送一次。 |
| 208 导入丢答但后台未安装 | 内存返回unknown/未找到 | 不自动重导入、旧preview不可提交、明确未生效。 |
| 219 导入草稿受关闭/目标导航保护，正文不执行HTML或图片 | 草稿直接装配；真实组件SSR保留 | SettingsState导航阻止、放弃后导航；script/img/javascript/iframe全不进入活动HTML。 |

真实集成保留61双壳的选择→导入、87来源路径/选择票据/连接代次门禁、110外部只读、124后台修订冲突、138磁盘仅一个包且宿主拒绝再次消费。双壳选择入口不同，不能直接删一壳。若进一步裁剪重复后续操作，可让MyGo保留选择→导入，公共启停/移除的完整持久流程由Electron分支持有；这是可选重组，不是当前已证明的墙钟收益。

## 应保留的容易误判项

- desktop-browser-security:51源码正则目前是Electron主frame IPC/preload隔离、subframe导航/重定向、下载禁用的直接接线证据；纯security函数测试不能替代，所以保留。
- desktop-demo-v4虽有demo文件名，实际前两条测正式CodeState/tab-order，后条SSR正式git-graph；不整删。只有上表明确直接运行Demo实现的副本退出。
- desktop-file-tree-loading、desktop-git-lazy、desktop-interaction-regressions、desktop-polish虽仅8–13行，但调用.scratch内实际组件回归脚本；文件树取消展开意图、IntersectionObserver迟到、Tab完整拖动周期、Markdown缓存/前置路径/附件刷新、flow排序成本不同，不能看薄包装就判重复。
- desktop-git-windowing:58保留实际SSR渲染数量、ARIA和占位高度；git-layout算法测试不能证明DOM只渲染窗口。70000历史规模证明大数组/窗口算法，400+真实Git历史证明跨页到根和refs，不互相替代。
- Personal services/service-operations的检查与写操作有不同效果边界；正常/取消/超时/真实强杀、主/子/定时来源与stop证明是不同契约。未找到可直接整删的额外同边界重复。
- personal-file-search真实原生执行与personal-tools的durable权限/产物/来源/恢复不同；个人与Coding共用底层库不等于两产品接线重复。
- personal-qq/telegram的传输成功结构、固定目标与菜单来源不同；同数字身份跨平台拒绝、发送未知不重发、恢复双向回链保留。
- Personal图片的规范模型输入与实际payload核实、压缩引用、Responses工具图片分别保护不同发送窗口；不得只留一个编码正例。

## 38-desktop-personal额外复核

已有工单建议成立：138分类表直接tokenFailure，留一条真实子进程字节/locale；160同类网络文案保留一个真实重连，zero/signal独立保留；228的15秒期限与312指数退避可控时钟。必须保留真实TERM→KILL及忽略TERM的子进程回收证据（读取超时与读取中替换目标有真实进程）；改虚拟计时不能把仅发出信号当OS已停止。令牌轮换、认证/协议/产品错误、目标隔离与未知提交重连仍保留。本轮没有新增此文件的删除候选。

## 完整文件清单及模块结论

以下文件名相对test/。首批候选仍按工单；本报告只补充上表。没有明确列为删除/合并/降层的文件保留。广泛集合通过用例目的、夹具及关键断言归类，优先文件逐段读完。

### Desktop 会话投影与输入：保留（7）

`desktop-agent-display.test.ts`、`desktop-attachments.test.ts`、`desktop-composer.test.ts`、`desktop-context.test.ts`、`desktop-demo-v4.test.ts`、`desktop-tool-activity.test.ts`、`desktop-trace-hydration.test.ts`

### Desktop 文件/Git/浏览器/终端与交互：上述Demo副本退出，其他保留（13）

`desktop-browser-documents.test.ts`、`desktop-browser-security.test.ts`、`desktop-file-tree-loading.test.ts`、`desktop-git-layout.test.ts`、`desktop-git-lazy.test.ts`、`desktop-git-windowing.test.ts`、`desktop-inspector-tools.test.ts`、`desktop-interaction-regressions.test.ts`、`desktop-live-files.test.ts`、`desktop-polish.test.ts`、`desktop-terminal.test.ts`、`desktop-workspace-files.test.ts`、`desktop-workspace-git.test.ts`

### Desktop 设置与会话设置：已定候选及上述降层，其他保留（9）

`desktop-models-layout.test.ts`、`desktop-personal-settings-pages.test.ts`、`desktop-personal-settings.test.ts`、`desktop-session-settings.test.ts`、`desktop-settings-mcp-backend.test.ts`、`desktop-settings-mcp.test.ts`、`desktop-settings-models.test.ts`、`desktop-settings-skills.test.ts`、`desktop-settings.test.ts`

### Desktop 宿主与桥接：保留（3）

`desktop-mygo.test.ts`、`desktop-personal-interface.test.ts`、`desktop-startup.test.ts`

### Desktop 搜索：保留（2）

`desktop-search-runtime.test.ts`、`desktop-search.test.ts`

### Personal 资料/通用工具/记忆/技能：按首批压缩审查与损坏准备，其他保留（14）

`personal-app-data.test.ts`、`personal-artifacts.test.ts`、`personal-file-search.test.ts`、`personal-history.test.ts`、`personal-managed-skills.test.ts`、`personal-media.test.ts`、`personal-memory-controls.test.ts`、`personal-memory.test.ts`、`personal-skills.test.ts`、`personal-tool-fifo.test.ts`、`personal-tool-io.test.ts`、`personal-tools-config.test.ts`、`personal-tools-controls.test.ts`、`personal-tools.test.ts`

### Personal 后台进程：保留（1）

`personal-background-processes.test.ts`

### Personal 浏览器与Cua：保留（3）

`personal-browser-integration.test.ts`、`personal-browser.test.ts`、`personal-cua.test.ts`

### Personal 档案/入口/配置/维护：按首批合并Pi版本断言，其他保留（8）

`personal-cli.test.ts`、`personal-configuration-controls.test.ts`、`personal-durable.test.ts`、`personal-entry.test.ts`、`personal-maintenance.test.ts`、`personal-mock-provider.test.ts`、`personal-settings-blockers.test.ts`、`personal-settings.test.ts`

### Personal 命令执行：按首批精简模式/损坏准备，其他保留（4）

`personal-command-config.test.ts`、`personal-command-execution.test.ts`、`personal-command-work.test.ts`、`personal-command-worker.test.ts`

### Personal 委派/追加/报告：保留（6）

`personal-delegations.test.ts`、`personal-reports.test.ts`、`personal-work-controls.test.ts`、`personal-work-notes.test.ts`、`personal-work-tools.test.ts`、`personal-work.test.ts`

### Personal MCP：保留（4）

`personal-mcp-config.test.ts`、`personal-mcp-controls.test.ts`、`personal-mcp-recovery.test.ts`、`personal-mcp.test.ts`

### Personal IM/权限/持久提问：保留（4）

`personal-qq.test.ts`、`personal-questions.test.ts`、`personal-telegram-permissions.test.ts`、`personal-telegram.test.ts`

### Personal 定时：保留（6）

`personal-scheduler-authority.test.ts`、`personal-scheduler-browser.test.ts`、`personal-scheduler-controls.test.ts`、`personal-scheduler-entries.test.ts`、`personal-scheduler-integration.test.ts`、`personal-scheduler.test.ts`

### Personal 服务检查/操作：保留（2）

`personal-service-operations.test.ts`、`personal-services.test.ts`

### 额外复核（1）

`38-desktop-personal.test.ts`，按上文保留/降层，合计87个文件。

未执行测试、负例突变、基线或平台验收。Runtime启动次数是源码计数，任何性能收益须按完整文件进程墙钟实测。
