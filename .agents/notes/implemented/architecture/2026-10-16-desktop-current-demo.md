# Agent Note: Desktop 迁入当前 demo

Status: implemented

[文件树续页](../feature/2026-10-24-directory-pages-lazy-git.md)取代目录每层 200 项总上限，保留分页容量、路径与读取一致性核实。

[读取检查复用](../bug-fix/2026-10-24-read-check-overhead.md)取代文件预览的多硬链接拒绝，其余路径与读取一致性要求保持。

工作区浏览的保护根约束由[拥有者浏览权限](../feature/2026-10-24-owner-workspace-browsing.md)取代；登记根、路径及读取一致性规则继续适用。

文件预览总量上限由[完整分块传输](../feature/2026-10-18-complete-reasoning-and-preview.md)部分取代；原访问范围继续成立。

## 问题

拥有者要求把经过多轮批注的当前 demo 迁入正式 Desktop。旧[冻结迁移](2026-10-15-desktop-shadcn-demo.md)不含 AI Elements、Context、Effort 和右栏浏览器／文件视图，直接覆盖 renderer 会丢真实状态，直接复制 fixture 会伪造数据。

## 决定

保留提交幂等／恢复、审批、单次差异及历史语义，展示层按 demo 更新并补齐最小只读接线。按[工单](../../../../.scratch/desktop-shadcn/issues/05-current-demo-migration.md)冻结 v2，旧快照不变；新主题和原语直接复制，原生窗口适配独立追加。

Context 接既有选择记录和窗口快照，Effort 接模型真实档位，thinking 用已记录文本和时间。缺数据保持未知。浏览器沿用隔离 iframe 与原生碰撞／标签交互，不接模型工具浏览器；文件只从已登记工作区经有界只读控制面取得，复核根身份、保护根、相对路径和读取稳定性。

## 备选方案

- 整体复制 demo App：保持外观最快，但会以静态数据替代真实模型、目录和提交状态；只复制展示原语与样式。
- 引入 Electron WebContentsView：能获得完整浏览器能力，但增加原生层坐标、弹层遮挡与额外权限；采用 demo 已明确的 iframe 限制。
- renderer 直接读取本机文件：少一层控制面，但会给前端任意本机读取；根目录与路径授权留在后台。

## 后果

本篇 thinking 正文与工具详情决定由[后续 Trace 迁移](2026-10-16-desktop-trace-migration.md)部分取代，原迁移证据与其他边界继续保留。

工程与隔离 Electron 验收见[工单](../../../../.scratch/desktop-shadcn/issues/05-current-demo-migration.md)。新旧冻结稿分别保留，主题和全部原语逐字可追溯至 v2；真实思考与工具空正文在渲染前过滤，避免无内容的消息行占距，纯附件消息仍显示。独立审查发现的断线转发、Context 在途新事件刷新与空消息外层间距均配最窄回归。

iframe 受站点嵌入策略限制，地址栏历史不包含网页内部历史；网页没有 bridge、Node、设备或顶层导航权。文件单层返回 200 项、预览 256 KiB，截断与不支持显式可见；Node 的路径前后复核不等同原子 openat 沙箱。Context 容量来自记录快照，缺失保持未知。协议提升到 28，旧客户端明确拒绝。

旧冻结迁移与本篇部分重叠，旧批准、附件、分页及恢复理由继续成立；[右栏 demo 试验](../feature/2026-10-16-demo-inspector-tools.md)的静态内容与 demo-only 边界由本轮明确迁移授权取代，旧证据不改写。未在新 demo 体现的后台能力继续保留清单。

文件树目录保护检查的批量扫描与目录分类稳定性由[目录保护优化](../bug-fix/2026-10-17-directory-protection-cost.md)补充；文件预览及其他宿主工具继续本篇与原生执行约定。

PA、标签排序、Git graph 与玻璃层的后续迁移由[当前迁移](2026-10-17-desktop-demo-v4.md)持有，本篇其他行为继续适用。

后续局部调整见[后续决定1](../bug-fix/2026-10-17-desktop-file-tree-refresh.md)；对应生命周期与默认设置以新决定为准，其余迁移契约保留。
