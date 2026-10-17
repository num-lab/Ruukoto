# Git graph 标签与提交详情

Status: ready-for-human

## 目标与依据

拥有者在2026-10-17要求分支名和tag使用对应分支线颜色并放到提交信息前面；点击提交展开详情，时间与短哈希仅在详情内显示。沿用[工单17](17-git-graph.md)的可变demo、只读样例、仓库入口守卫、按会话标签与可访问性，不迁移正式Desktop或接真实Git。

拥有者随后提供标签截图，要求只有左侧图标区变色、名称保持普通颜色，去掉最外层线框。该要求取代整个标签文字同色的视觉规格，详情行为与图线接续保持。

## 方案与范围

每行用现有Radix Collapsible实现独立展开／收起，原生button触发并支持Enter／Space与aria-expanded；摘要把refs放在主题前方，不显示时间或哈希。refs使用shadcn Badge，图标区与节点／分支线共用同一个lane语义色。详情只显示现有样例中的完整主题、作者、日期、短哈希与父提交，不新增模拟字段或Git写操作。

标签改为图标区、名称、可选远程名三段，图标区底色取lane色，图标用对比色，名称与远程名使用普通文字颜色；保留远程名内部短分隔，外框为零。Git ref样例改为显式branch／tag类型和可选remote，避免从v前缀或斜杠猜类型；现有标签事实仍为main、origin/main、offline-cache及v0.3.0。分支用GitBranch、tag用Tag图标，不增加依赖。需同步两个仓库fixture、渲染和危险文本用例，其余DAG及入口不变。

现有整图按固定56px行计算，无法随内联详情变高。保留纯函数DAG和lane分配，把SVG按提交行分段，摘要节点保持固定纵向位置，跨行边延伸至该行实际底部，下一行连续接上；不引入DOM测量、ResizeObserver或新依赖。折叠复用demo现有动效并尊重减少动态效果偏好，原读屏父关系保留。

影响git-graph.tsx、git-graph-data.ts的ref类型与fixture、局部CSS、shadcn Badge源码、check-inspector自检、demo README、决策笔记和证据。App入口、仓库资格、提交父关系与lane计算保持原样，不修改冻结稿及生产代码。单写入者为root；独立审查只读。

## 验收与交接

定向SSR验证refs先于主题、lane颜色关联、摘要无时间／哈希、默认折叠且有可访问触发器；直接验证详情的元数据与React转义，继续验证分叉／合并／根／截断父边和读屏关系。实际浏览器点击／键盘展开收起、多个提交同时展开、图边跨详情连续且后续节点对齐、蓝色分支与tag位置、窄栏及明暗主题，仓库／空仓库／非仓库规则不变。demo check、check:static与diff检查，独立实现审查通过后交拥有者审阅观感。

已有Git图决定部分重叠，新详情取代旧轮不提供提交详情的范围；需新笔记并互链，保留旧轮记录。tab_avoidance_review独立方案审查通过：每行SVG不使用viewBox，节点固定cy=28，跨行边用百分比line连接，动效也只延长竖线。实现与验证由root继续，无需拥有者再次确认。

## 验证与审查

实现、README及新决策笔记已完成，demo check、check:static通过；[实际浏览器证据](../evidence/git-commit-details/README.md)含10个状态、14项通过断言、动画中间帧和暗色／浅色／窄栏截图。提交点击、Enter／Space、多项展开、元数据位置、refs同色与顺序、图线跨动态行高连续、节点对齐、完整读屏名称均通过。仓库资格、空态与原DAG回归继续通过，生产代码和数据未改。

tab_avoidance_review亲跑原详情render／tsc／diff及独立证据断言通过；曾要求移除覆盖refs的aria-label，已修正并增加回归，最终AX确认HEAD、分支、tag完整名称。原10状态与动画证据已独立最终复核通过；新图标标签取代文字同色的样式结论，旧状态仍是当时事实。

图标标签增量方案、实现与最终证据经tab_avoidance_review只读审查通过，无未解决阻断，亲跑render／tsc／diff及7状态独立断言通过；同名local／remote的key包含type、remote和name，自然读屏名包含类型与远程名。[新标签证据](../evidence/git-ref-tags/README.md)含7状态与14项通过断言，Nexus双标签在260px右栏均完整可见，refs高38px、摘要56px，图标区颜色、文字中性、外框0与内部线1px均通过。最新demo check、check:static与diff通过，拥有者审阅观感。真实Git与正式Desktop未验收，保留既有未提交改动，本轮未提交。

## 紧凑行修订

拥有者要求行高减半并去掉右箭头，按局部样式轻量路径修订：摘要56px减到28px，节点14px及弯线由同一行高派生；删除箭头与旋转样式。多标签改单行、省略长名而保留完整读屏名，避免原38px换行标签越过28px行。展开详情行为、标签配色与图线动态接续不变；补定向SSR与实际单／双标签、窄栏、展开后的几何和键盘检查。此前56px／双标签换行证据保留为旧密度事实，本次紧凑状态取代其当前尺寸结论。

最新demo check、check:static通过；[紧凑状态证据](../evidence/git-compact-rows/README.md)的4状态与9项断言通过，28px摘要、14px节点、无右箭头、18px单行双标签、图标／remote可见、展开后图线接续和Enter／Space均实测通过。tab_avoidance_review独立最终复核无阻断，亲跑render／diff与4状态几何／自然AX断言通过；拥有者审阅紧凑观感，真实Git与正式Desktop仍未验收。
