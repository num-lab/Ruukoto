# 正式 Desktop 迁移验收

2026-10-16，macOS arm64、Node 24.15.0。实施依据为[迁移工单](../../../issues/02-desktop-migration.md)与[冻结清单](../../../approved-demo-manifest.json)。代码及工程验收完成，正式 GUI 的主观一致性和下述保留项交拥有者核对。

## 一致性与范围

23 个冻结文件的 SHA-256 全部匹配。正式界面的 reference.css、sidebar-resizer、utils 与六个 shadcn 源码组件和冻结副本一致（组件仅替换 import 路径）；style.css 以冻结样式原文开头，之后只追加原生窗口、真实 Markdown 和审批参数所需适配。`test/43-desktop-demo.test.ts` 固定这些来源，并验证摘要按不同文件计数、SubAgent 独立分组。

Electron 使用系统窗口按钮与拖动区，客户区填满窗口。正式设置保留外观与运行目标，演示场景未进入产品。正文下限处审批标题和按钮组可换行。独立方案、布局与状态实现、附件及分页复核均无未解决代码阻断。[后台 UI 清单](../../../backend-ui-backlog.md)中的其他能力未新增界面。

附件经原生选择器、主进程快照和分块上传接入真实 submit／continue；普通文件由 read_artifact 读取，图片进入模型请求的视觉内容，JSONL 只保留引用。长工具结果的 more 使用真实字段分页。协议统一为 v27，不能与旧后台混用。

## 工程检查

| 检查 | 结果与范围 |
| --- | --- |
| `npm run check:static` | 通过；lint、workspace 类型、静态约束、文档、笔记与换行检查 |
| Desktop 与历史投影定向回归 | 161/161；test/11、36、37、38-main、38-personal、38-build、39、40、41、42、43 与 desktop-attachments |
| 附件最后增量 | EventFlow 与附件 20/20；实际 test/96-vision-driver 另跑 4/4，覆盖具名错误与附件占位乱序 |
| 额外后台回归 | 原 214 条首轮有 9 条跨主机休眠超时，不计通过；其余 205 通过，原 9 条在 caffeinate 下定向重跑 9/9 通过 |
| `test/72-on-demand-backend.test.ts` | 24/24，覆盖按需后台入口 |
| 子 Agent 展示与最终 renderer 回归 | 50/50；desktop-agent-display、36、37、38-build、41、42、43；独立复核另亲跑相关 17/17，及真实 CodeState 恢复链和 Conversation SSR 断言 |
| `npm run build` | 通过，最终逻辑增量后重建 worker 与两产品 |
| `npm run desktop:build` | 通过，最终样式适配后重建，含产物检查及 arm64 应用打包 |
| `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Ruukoto.app` | 通过，本机 ad-hoc 签名；未公证或发布 |
| `git diff --check` | 通过 |

检查分阶段执行，重叠用例不相加为新的总数。最后两条审批换行 CSS 已独立复核冻结前缀并读图确认；最后笔记路径、注释与文档同步后再跑静态检查。附件详细模型可见性与故障验证见[附件验收](../../../../owner-attachments/verification.md)。没有运行全仓 `npm run check`。

## 真实 Electron 检查

`electron-fixture.mts` 使用临时 Code Runtime、ControlServer、真实工具 worker、独立 userData 与确定性的本地模型 HTTP；不连接日常数据，不修改 Personal 配置。Mac 解锁且拥有者手动置前后，原生 UI 控制恢复；此前锁屏和输入失效的尝试不计通过。

| 实机场景 | 观察结果 |
| --- | --- |
| 原生附件 | 系统选择器选择 clock.txt 与 empty.ts；会话切换隔离附件；移除单项；纯附件发送后出现引用气泡并清空附件；取消选择不改草稿 |
| 设置与主题 | 左类别右设置，明暗切换实际生效；运行目标类别显示已有 Code 选择器；菜单 Escape 与浮窗 Escape 逐级关闭并归还焦点 |
| 菜单与侧栏焦点 | 模式／模型菜单避开自身选择框；设置内菜单打开时 Cmd+B 同时关闭门户并聚焦展开侧栏；检查器内 Cmd+J 收起后聚焦顶栏开关 |
| 宽窄布局 | 常规 1160×780 与最小约 760×500；两侧展开、正文约 220px 时审批标题单行、按钮组换行且完整；输入工具栏换行并保留提交／停止 |
| 侧栏调宽 | 两侧方向键调整、收起再展开保留偏好；左栏鼠标拖动从 248px 到 280px，窗口缩小按边界夹紧 |
| 审批 | 原生 UI 批准和拒绝均在权威响应后移除卡片，后台结束后按钮恢复空闲；运行期间显示停止图标 |
| 差异 | 空 Write 只有文件头与零行普通内容区；large.ts 经 more 加载至新-999／行号 1000，末页按钮消失；横向滚动后代码移动而行号及 + 标记位置不变 |
| 会话与 Agent | 新建会话聚焦输入框，关闭标签仍可在树中找到会话；父会话独立右栏标签；子会话显示原始委派请求与实际回复，活动行是实际身份状态 |
| 会话切换回归 | 修复同级 Conversation／Composer 重复 key 后，A → B → A 只保留一份输入框，旧消息与滚动区域不累积；原始 JSONL 没有被改写 |

子任务 `displayInput` 只由可核实的成功父级委派调用派生，失败、效果未知或无法唯一关联不作为候选；前端仅替换子会话用户气泡，父消息和助手回复不替换。ViewState 的旧 seq、快照与实时更新保留该不可变元数据，测试覆盖跨实例清空与协作继续。

截图：[深色主界面](electron-dark.png)、[浅色主界面](electron-light.png)、[浅色设置](electron-settings-light.png)、[子 Agent](electron-agent.png)、[窄窗审批](electron-narrow-approval.png)、[more 末页](electron-more-last.png)、[横向固定行号](electron-fixed-gutter.png)。截图来自实际 Electron，系统控制工具的紫色角标不属于产品 UI。最终 AX 断言结果留在 electron-final-ax.txt。

测试结束后隔离 Electron、后台、控制目录与临时 userData 已退出清理；浏览器 demo 保留。可从仓库根重跑 `npx tsx .scratch/desktop-shadcn/evidence/2026-10-16/migration/electron-fixture.mts`，通过原生 UI 操作窗口。command 文件的 release-child、next-approval、quit 只控制自建测试状态；子模型被刻意挂起，验收回复时应及时 release-child。最终代码与测试哈希见 source-hashes.json。

## 保留限制

右栏原生自动拖动多次未取得稳定宽度变化，不能记为鼠标拖动验收通过；方向键与共用边界逻辑已验证，人工体验核对仍需复验此项。原生待核实加载图标未截到稳定帧，其锁稿和权威确认行为由定向测试覆盖。没有调用真实模型服务或真实 SSH，也未改系统的减少动态效果设置。

附件暂存没有自动清理，未提交或移除的快照会累计磁盘用量；每次最多 4 个、每个 8 MiB。普通二进制只提供字节读取，不自动解析 PDF 或 Office。普通未发送草稿与主题、侧栏偏好仍只在内存中，待核实输入按原持久记录恢复。没有提交、推送或发布。
