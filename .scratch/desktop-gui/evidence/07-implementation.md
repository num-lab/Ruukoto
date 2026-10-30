# 右栏 SubAgent 与工具差异验收

实施基点 `0c2d473`；依赖的会话恢复工单已 resolved。范围与标准见[工单](../issues/07-inspector-subagent-and-diff.md)及[共享规格](../spec.md)。环境为 macOS Apple Silicon、Node 24.15.0、Electron 44.7.2，外部探针使用临时 Code Runtime／ControlServer 与确定性本地模型替身，读写仅作用于探针自有文件。

## 实现与影响范围

Code 右栏提供 SubAgent 与差异两页。工作委托通过既有 work_list／work_get 查询，全部 SubAgent 按父会话归属显示；任务详情只读。子会话复用 CodeState 的历史、任务事件与 UTF-8 正文恢复及 Conversation 组件，实时正文补读与每次快照重载均覆盖当前子会话。通知定位父会话时同时打开子会话右栏，不把子会话加入普通会话标签。

edit／write 条目均可点击，差异始终绑定原工具和原会话。结果判定与 unified patch 行分类为纯函数：先保留运行、失败与效果未知状态，历史条目 ID 只决定读取资格；只有 done 且结果明确 isError: false 才显示 patch／写入内容。空文件、字段缺失与截断分别可见，不回退到调用参数，不提供 Accept／Reject。

主进程新增三个实际使用的 op 放行；control 的类型表补齐已有 work_list／work_get，不新增协议或后台行为。文档、决策提案、测试导航与提交前检查同步。没有新增依赖，没有读取工作区文件、数据库或 JSONL 的桌面代码。

## 工程检查

| 检查 | 实际结果 |
| --- | --- |
| 桌面及控制面定向 | `38-desktop-main`、`38-desktop-personal`、`38-desktop-build`、`39-desktop-recovery-guide`、`40-desktop-creation`、`41-desktop-stream`、`42-desktop-inspector`、`66-control-seam` 初次组合 131/131 通过；之后新增与修复的最终 `41`＋`42` 为 18/18，通过 |
| 差异与工作读取 | 最终 `42-desktop-inspector` 8/8：失败 Write、效果未知、无 ID、空文件、缺字段、patch 行分类、子会话来源、旧快照迟到、查询竞态、IPC 拒绝重试及历史工具身份恢复 |
| 静态门禁 | 最终 `npm run check:static` 通过，含全仓 lint、typecheck、笔记与文档校验；`git diff --check` 通过 |
| 构建 | `npm run desktop:build --workspace=@ruukoto/desktop -- --config.electronDist=/Users/eitrous/Developer/ruukoto/node_modules/electron/dist` 通过，复用已安装的同版本 Electron；普通入口的重复下载耗时较长，已停止该下载进程 |
| 签名 | `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Ruukoto.app` 通过 |

未运行全量 `npm run check`；未改共享投影、任务执行或存储，不扩大到全仓测试或 Linux／Node 22 矩阵。

## 独立实现审查

不同执行上下文直接阅读工单、规格、实际 diff 与调用方，并亲跑桌面主进程、会话恢复、差异和控制面用例。发现查询缓存遮住已收到的关闭、取消与新委托事件：查询失败会使旧列表继续显示。修复为受代次和查询序号保护的成功查询按 ID 合入 view，渲染始终读取同一投影；后续事件直接更新它。

最终独立复核 `41`＋`42` 为 18/18、`66` 为 23/23，通过。审查者用内存模块恢复旧缓存优先逻辑，关闭、取消和新增委托三项均失败；当前实现三项均通过，证明回归可捕获原缺陷。独立实现审查结论：通过，无未解决阻断。真实 GUI 证据由另一执行上下文取得，和本节纯逻辑检查分别记录。

## 真实 Electron 与产品验收

独立外部验收使用真实 Electron 加载最终 out，连接真实临时 Code Runtime／ControlServer，模型为确定性替身，edit／write／read 均走真实 worker。最终完整结果见[验证记录](07-electron/verification.json)，构建身份见[摘要](07-electron/build-manifest.json)：renderer 为 `index-jumCLPhu.js`，SHA-256 为 `8c3ca0f5158cf01ea3e8700abf1e69295608171dbaa980021c994303003a36c9`。

| 外部验收项 | 结果与证据 |
| --- | --- |
| 编辑与截断编辑 | 真实小 edit 的增删与上下文行正确；大 edit 返回截断标记，GUI 明确提示 64 KiB 上限，见[普通编辑](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fedit-small-light.png)、[截断编辑](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fedit-truncated-light.png)及[接口结果](07-electron/tool-results.json) |
| 新文件与空文件 | 新文件显示准确写入正文；成功空 Write 显示空文件（0 行），见[新文件](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fwrite-new-light.png)、[空文件](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fwrite-empty-light.png) |
| 失败 Write | 真实写入已存在目录失败，目标仍是目录；返回仍带参数还原的 never written 正文，但差异页只显示失败，见[失败记录](07-electron/write-failed.json)与[截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fwrite-failed-light.png) |
| 子会话运行中重连 | 真实委派后显示两段思考、一个成功 read 与当时的两条消息；通过真实桥接重连后条目内容和数量一致，无重复或缺失，完成后的最终回答仍出现在所选子会话，见[重连前](07-electron/subagent-before-reconnect.json)、[重连后](07-electron/subagent-after-reconnect.json)、[最终回答](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fsubagent-completed-dark.png) |
| 外观与最小窗口 | 明暗可读；原生窗口设为 760×500，文档 scrollWidth 为 760，两页均可用，见[差异页](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fminimum-window-diff-dark.png)、[SubAgent 页](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-gui%2Fevidence%2F07-electron%2Fminimum-window-subagent-dark.png)与[视觉记录](07-electron/external-review.json) |
| 打包资源启动 | 使用已安装的同版 Electron 加载最终 app.asar 内的 main／preload／renderer，成功连接真实临时实例并打开工作区，见[环境](07-electron/packaged-smoke/environment.json)与[结果](07-electron/packaged-smoke/verification.json)；未直接双击 .app |

最终 app.asar SHA-256 为 `ef49cae47bc5f97bf23c04890de58c74a720f3bbfb85bfb1706d2e37ac9c5836`。两次最终探针的 Electron 均正常退出，进程、临时 Runtime、工作区与控制目录已清理；没有访问日常档案。此前旧构建的 GUI 结果不作最终证据，归档仅包含最终版本。

子会话 GUI 探针的模型替身没有输出非空思考正文，证明的是思考计时条目及工具、消息的恢复与去重；非空思考正文由 `41-desktop-stream` 的子会话回归覆盖。最终独立文档复核已核对工单、实际构建摘要、归档结果与上述环境限制，未见实质误报。

本单沿用已确认的外观和产品边界，没有新增需要拥有者决定的主观取舍。真实模型、原生沙箱、Linux／Node 22 不在本次外部探针覆盖范围内；模型替身与测试 local 执行环境不代表这些验证通过。拥有者已授权本地提交；未推送或发布。
