# Desktop 配色、字号、拖动与完整 Git 历史

Status: ready-for-human

六项需求同时同步 Demo/Desktop；不提交、不推送，不重启日常后台。根是当前checkout唯一写入者；Git实现使用独立managed worktree，从当前含未提交迁移的内容精确复制并以索引为基线，根核实并只合入增量补丁。先只读方案审查，后实施。保持已有冻结v4及共享原语不动，另存 approved-demo-v4-polish.css 差量并同步来源断言。

Git：200保留为单页容量，不设累计上限。read_workspace_git 加opaque cursor；内部offset+revision（SHA256，HEAD、全部ref名称/OID、Git目录身份及shallow边界）。前后读取核实revision；变化workspace_git_changed，可见错误与刷新。仍固定argv、5s/512KiB输出/768KiB响应预算及保护根检查。Inspector首次读取/刷新与loadMore分开，追加成功合并已加载前缀，重复请求去重；generation+cache对象+cursor防迟到。追加失败保留历史，可重试原游标；界面“加载更多”。累积commits统一layout，用memo与逐行边表避免全edges逐row扫描。升级协议31，相关固定版本fixture/文档同步。Demo静态样本展示全部现有数据即可，不伪造真实分页。两端branch/node/edge/reficon使用相同专用彩色lane tokens，文字中性。

Tab hover：现Demo实际DOM读到拖动后的旧位置tab仍匹配:hover。保留原生拖动与源隐藏修复，在tab list新增hover暂停状态：dragstart、drop、dragend及成员/组变化时清空hover资格；仅后续非拖动的真实pointermove恢复。所有hover背景、关闭图标及渐隐都受此资格控制；focus-visible不受影响。根先复现保存DOM/截图，hook生命周期用例及真实Demo拖动/后续指针/键盘复验。不以source隐藏修复代替hover修复。

样式：dark新增局部--selection-surface=半透明白，仅左栏active-pill与两个tab active背景采用，活动项hover仍保持该选中色。仅移除.inspector-header横向border-bottom，保留::before短竖线与内部工具栏线。所有非消息CSS显式px字号逐项+2；body13.5→15.5；Tailwind text tokens在:root+2，消息主/子容器显式恢复原tokens与基准。composer、portal菜单/设置、Git、diff、文件树/预览计入；消息流正文、工具/审批、子对话保持原字号。iframe页面与原生OS菜单不注入。保持源码/gutter共同23.8px行高；窄窗13px模式与右tab13.5px单列。通过新CSS差量保存来源，不改冻结reference/theme/primitives。

验证：Git超过两页真实历史、跨页分支/合并无重复漏失、ref改变/无效cursor拒绝、权限/输出/预算旧用例；Inspector追加失败/并发/刷新失效；tab hook红绿+实际拖动hover/close/mask和键盘focus；Demo暗/亮/窄窗computed typography和选中alpha，源码gutter对齐；check:static、受影响test、Demo check、MyGo/Electron构建，签名与Go race只按实际宿主变化需要选。新的notes/docs/工单/证据对应上述行为。

## 审查与执行

独立方案审查可实施；游标覆盖全部refs与shallow及目录身份，分页时非仓库转changed；hover暂停关闭按钮鼠标命中，键盘focus保留。Demo红循环捕获原位置MCP仍匹配:hover，背景、关闭图标和文字mask全残留；实际两组拖动均已绿，后续指针恢复与键盘Tab焦点亦通过。六项代码和文档已完成。独立实施审查发现info/grafts遗漏，已用203→103的准确反例和普通／common目录跨页、页内三项红转绿补齐，原反例经独立复核通过。字号各66处映射、消息隔离和横线范围独立审查通过。最终静态检查、相关回归、Demo、两种桌面构建及签名通过，详细命令、日志、截图和指纹见[验收记录](../evidence/polish-history/README.md)。

## 待验收与交付

Demo实际交互与计算样式通过，原生MyGo拖动／hover待恢复鼠标自动化或人工复验；已有窗口定位失败前提仍在，本轮不重启日常应用。70000条只验证布局纯函数，超大DOM实际帧率未验证。保留原验收标准，工程与独立审查完成后保存ready-for-human，拥有者查看视觉效果和原生体验；无新增待决定的实现方案。协议31需同步后台，未提交、未推送。
