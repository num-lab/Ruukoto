# Desktop 同步当前 Demo

Status: ready-for-human

## 目标与授权

拥有者要求「把调整同步到desktop」。迁移当前可变 Demo 相对 approved-demo-v3 的全部调整：Ruukoto 单一 PA 主会话与远程连接设置、两组可拖动等宽自适应标签及避让、真实仓库 Git graph／紧凑标签／提交详情、左栏和公共顶部毛玻璃。保留已有 Code 会话、审批、附件、模型、Context、恢复与安全边界。不提交、不推送、不重启日常应用或后台。

## 方案

冻结当前 Demo 为 approved-demo-v4 并记录哈希，旧快照不变。复用 UI 原语及样式，保留 Desktop 原生／真实 Markdown 适配，不复制样例业务数据。主标签按 target 和 session 隔离；左侧工作区常驻 Code，Ruukoto 聚焦唯一 PA main session；未配置与离线显示真实状态并引导设置。PA 主身份由控制面快照 mainSessionId 提供，不能猜 roleSessionIds 顺序或名称。设置复用已有 host/controlDir 落盘及 SSH 生命周期，保存结果未知时重读，不假报成功。

PA 开放消息历史、执行事件、工具详情、模型／模式（排除 Plan）、Context、审批、队列与发送所需最小白名单，复用 DesktopSubmissions 持久化核实；按 host/controlDir 隔离 pending store。Inspector 注入 target，PA 只提供浏览器和 SubAgent；文件／diff／Git 动作也拒绝。附件 bridge 显式携带 target，Electron、MyGo 与 Host 校验原连接及实例后上传至对应后台，保留现有上传限制。主会话目标切换不重置草稿或在途状态。

Git 只通过 Runtime／control 已登记工作区读取，Desktop 不直接运行 Git。新增 read_workspace_git，仅接 workspace_id；返回 workspaceId 与 repository:null 或真实 head/commits（含父节点、主题、作者、时间、显式 branch/tag/remote refs）。非仓库 null，空仓库 commits 为空，失败为带 code 的可行动错误；限制提交数量、输出大小、超时，不接任意 args/path，不写 Git。沿现有 cwdReal 身份校验，Git 禁止环境／配置注入、pager、可选锁与外部命令。快照增加 mainSessionId 与新增 op 同步升协议一次。Inspector 请求去重并按实例代次及 state 身份丢弃迟到响应；新标签入口仅确定是 Git 仓库时显示，失败可重试。

Tab 复用 Demo 排序算法和 CSS，同组拖放、邻项避让、取消恢复、键盘排序及读屏播报；每个标签保留既有对象、活动项与浏览器历史。主组跨 target 身份唯一，右组按父会话保存；关闭／切换取消过期拖动。CSS 使用 app-window 唯一玻璃底层，左栏、两个顶栏和圆角缺口共用，不叠加模糊；保留不支持和减少透明效果的实色回退。

## 实施分工与文档

根代理为当前 checkout 唯一写入者。后端 PA／Git 与其回归可由代理在独立工作副本实施后精确合入；其他代理只读方案／实现／证据审查。同步 desktop、control、runtime、view 受影响模块文档、usage 配置入口和测试导航，记录新迁移决定及部分取代关系，不改不可变归档。

## 验收

最窄回归覆盖 PA main 身份、跨目标读写／pending／附件及旧 Code 兼容、权限白名单、历史和执行尾部、Context、PA Inspector 禁区；Git 真实临时 repo 的分叉／合并／标签／remote／空仓库／非仓库／失败／上限及恶意输入；图线布局沿用已验纯函数，缓存过期与重试、Tab 排序和对象身份、冻结来源。运行 check:static、受影响定向用例、Demo check、MyGo Go race 与生产构建、Electron 构建和签名。必要真实环境验收使用隔离 profile／后台：MyGo 中 Code 与 PA 会话、两组拖放／键盘／关闭重开、Git 详情／非仓库、明暗和窄栏、毛玻璃回退。真实 SSH 或外部模型缺前提时明确未验证，不能把 mock 记成真实连接。

## 进展

实施与文档已同步：真实 PA 主身份／历史／输入与附件路由、持久 pending 隔离、远程设置、两组标签及 Git 后端与图均已接入。独立方案与实现审查通过，期间修复同实例 resync 的 Git 缓存补读和旧 PA 夹具；最后审查发现 HEAD 不可指向首个 ref，已改为独立徽标并补回归。检查、隔离原生环境、截图与明确未验项见[验收证据](../evidence/migration-v4/README.md)。

拥有者补充圆角缺口与玻璃接缝：裁切只留下透明缺口，分区采样也不连续。最终 Demo 与 Desktop 共用 app-window 单一玻璃层，left-sidebar／canvas-header透明且不单独模糊，content-body透明，main自身圆角保留。v4不改，最终冻结差量为 approved-demo-v4-glass.css，前两版独立圆角修正不采用。

工程检查与构建通过，真实隔离 MyGo 已验证 Code／PA 对话、PA 右栏限制、远程配置、Git／非仓库、键盘排序及 common glass 明暗主题。原生鼠标自动化返回 noWindowsAvailable，物理拖动和窄窗未完成；外部 SSH／模型、系统减少透明度开关与真实 Electron 窗口未验。工程实现审查无已知阻断，主观玻璃观感及这些环境体验交拥有者验收，因此保留 ready-for-human，不宣称产品验收完成。

最终独立证据与文档审查由 desktop_v4_review 完成，亲跑 HEAD 徽标回归，核对任务／AX／清理记录与链接，无未解决实现阻断。最终 check:static、5项收尾回归、两种外壳构建和签名、check:docs 通过，未追加全仓检查；验收细节与各轮失败／修复保存在上述证据目录。
