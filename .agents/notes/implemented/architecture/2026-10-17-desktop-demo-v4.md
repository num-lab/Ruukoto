# Agent Note: Desktop 同步 PA 与仓库标签

Status: implemented

## 问题

当前 Demo 的 PA 主标签、连接设置、拖动等宽标签、Git graph 和玻璃层尚未迁入 Desktop。正式端只有 PA 连接占位，Git 历史无读取接口；复制样例会把真实数据、发送核实和路径保护替换成模拟结果。

## 决定

按[工单](../../../../.scratch/desktop-shadcn/issues/19-desktop-demo-v4.md)冻结 approved-demo-v4，样式及原语保持来源断言，旧冻结不改。两组标签共享排序逻辑和槽位避让，主标签用 target 加会话身份区分，PA 主标签固定为 Ruukoto；右栏顺序仍归父会话。拖动不重建对象或修改激活项，取消还原；键盘排序及读屏播报与 Demo 一致。整个 app-window 共用单一72%背景与28px模糊底层，左栏、两个顶栏和消息区圆角缺口均透明露出该层；各区域不再单独采样，避免接缝。主内容与右栏正文实色，减少透明效果有回退。新增独立冻结差量 approved-demo-v4-glass.css，前两版圆角修正保留为未采用参考，不用于正式来源。

PA 主会话由快照 mainSessionId 明确给出，缺失时显示未就绪，不猜角色顺序也不创建 dev 替代。历史、工具、审批、模型、Context、队列及输入复用既有真实投影；Plan 只留 Code。PA 右栏只提供浏览器与 SubAgent，文件和 Git 在动作与 IPC 两层限制，右栏差异动作拒绝，行内工具差异仍可读取。设置读写既有 host/controlDir 配置；发送复用 DesktopSubmissions，未决记录按 host/controlDir 摘要分区，原实例未决输入不在其他连接重发。附件全链显式携带 target，系统选择器和每次上传均核实原控制器、连接对象与实例，Code 默认参数保持兼容。

Git 经 Runtime 与控制面 read_workspace_git 读取登记根，客户端不能传命令、绝对路径或根目录。返回非仓库 null、空仓库空 commits、真实父节点与显式 ref；固定最多200提交、总5秒预算、每命令512 KiB及结果768 KiB。固定 argv、清理 Git 环境、禁 lazy fetch、pager、replace 与外部配置引用，读取前后核实根及 Git 元数据身份和保护目录。为保持保护约束，拒绝元数据符号链接、硬链接、alternates、include/includeIf，并将扫描限制为100000项；普通 worktree 支持。失败可见并可重试，不把未知缓存成非仓库。缓存按工作区、实例代次与状态对象淘汰迟到响应。图沿用 Demo 的28px行、14px节点和每行 SVG，不把可变行高缩放为节点位置。HEAD 单独标记提交，不把它指向未被协议确认的分支。

协议统一升为 v29，包含 mainSessionId 与 Git 查询；不改数据库 schema 或会话 JSONL。main 附件复用已有拥有者快照存储，仍拒绝子会话上传。

## 既有决定

检索 Desktop、PA、Git、标签、附件、快照及毛玻璃的 proposed／implemented／rejected。与[当前迁移](2026-10-16-desktop-current-demo.md)、[Trace](2026-10-16-desktop-trace-migration.md)部分重叠：本篇更新视觉来源和 PA 入口，其发送、工具及滚动语义继续适用。与[PA Demo](../feature/2026-10-17-demo-personal-main-tab.md)、[连接设置 Demo](../feature/2026-10-17-demo-personal-connection-settings.md)、[标签排序](../feature/2026-10-17-demo-tab-reorder.md)、[动态宽度](../feature/2026-10-17-demo-responsive-tab-width.md)、[Git 图](../feature/2026-10-17-demo-git-graph.md)及[提交详情](../feature/2026-10-17-demo-git-commit-details.md)部分重叠，保留其样例验收，正式端用本篇真实接线。MyGo 宿主选择及其权限隔离继续由[外壳决定](2026-10-17-desktop-mygo-experiment.md)持有；其他命中不变。

## 备选方案

直接复制 Demo App 最快且能保留样式，但会覆盖真实状态和未决发送；仅复制展示层并复用正式控制器。Desktop 主进程直接执行 Git 能少一个协议入口，但绕过后台登记根和保护校验；由 Runtime 统一只读。按名称或 roleSessionIds 首项识别 PA 无需加字段，但角色顺序和用户命名不提供身份保证；快照明确 main。支持共享对象库能覆盖更多仓库，但保护验证须额外持有所有外部对象根，本轮明确拒绝。

## 后果

Desktop 与 Demo 的布局和交互保持一致，PA 同时获得真实单会话能力，Git 图可查看实际提交。升级需要同步后台协议；大仓库和外部元数据形式可能被有界读取拒绝，界面保留安全重试。外部 SSH、外部模型和原生体验的实际验证范围随工单证据记录，不以模拟通过代替。

后续局部调整见[后续决定1](../bug-fix/2026-10-17-desktop-tab-drag-source.md)、[后续决定2](../feature/2026-10-17-desktop-read-snapshot.md)、[后续决定3](../feature/2026-10-17-session-creation-settings.md)；对应生命周期与默认设置以新决定为准，其余迁移契约保留。

后续[Git分页](../feature/2026-10-17-desktop-git-history-pages.md)取代200条总上限，[字号与选中样式](../feature/2026-10-17-desktop-chrome-typography.md)及[hover资格](../bug-fix/2026-10-17-desktop-tab-hover.md)持有本轮局部行为；其他迁移约定继续适用。
