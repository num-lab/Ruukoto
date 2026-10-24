# Agent Note: 非消息区域的字号与选中样式

Status: implemented

## 问题

拥有者要求消息流之外所有文字增大2px，深色左栏与Tab选中项更亮且半透明，移除右栏与顶部Tab之间的横线；Git分支不得使用黑白灰。

## 决定

新增approved-demo-v4-polish.css差量，同步追加Demo／Desktop并保留来源断言，不改冻结reference、theme及原语。既有非消息px字号精确加2，默认正文13.5变15.5；Tailwind已用四种text token各加2，主／子conversation恢复原token和14px基准，消息代码、工具及审批维持原样。输入框、菜单portal、设置、Git、文件树和文件预览均计入；iframe站点与系统原生菜单由其自身管理。文件源码改14px后，行号与源码共同使用23.8px行高。

token 膨胀只该抬高显式 px 面；裸用 tailwind token 的原语会双倍抬高（text-sm 从 12px 基准直达 16px），因此 dropdown 菜单全部槽位、弹窗与设置容器里的按钮／输入框／Select 触发器／Item 文本、空态按钮统一钉回 14px 次级档（style.css 追加块锚回本篇），model-settings 页自定的 12px 标签保持在其后生效。

深色选中背景为14%透明白，仅作用于左栏active-pill与两个Tab区活动项；hover不覆盖选中色。仅移除inspector-header的border-bottom，两个顶部Tab区之间的28px竖线及内部工具栏线保留。Git使用独立六色lane token，明暗主题均有色；图线、节点与ref左侧图标同色，文字中性，超过六lane循环使用。

## 既有决定

检索Desktop、shadcn、字号、Tab、Git及玻璃层。与[Desktop迁移](../architecture/2026-10-17-desktop-demo-v4.md)、[图形样例](2026-10-17-demo-git-graph.md)及[提交详情](2026-10-17-demo-git-commit-details.md)部分重叠，本篇取代其非消息字号及中性lane色；图形结构、紧凑行高、只给ref图标着色和单一玻璃底层继续适用。其余命中无关。

## 备选方案

增大html根字号最短，但会改变rem间距与消息组件，不能精确表达仅文字加2；仅改body会遗漏显式px和portal原语字号。改全局accent能统一选中，但会连同菜单、代码与卡片变色，改为局部选中token。

## 后果

非消息文字更易读，主／子消息字号保持，窄区更早省略标题或收为图标；相同控件和Tab宽度约束继续适用。旧冻结稿不覆盖，字体映射、实际computed样式及截图归[工单21](../../../../.scratch/desktop-shadcn/issues/21-polish-history.md)。
