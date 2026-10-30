# Git graph 提交详情验收

环境：2026-10-17，可变GUI demo http://127.0.0.1:5173/，沿用用户IAB标签，默认855×827视口，无视口覆盖。本轮只操作Git graph、右栏宽度与主题，未改草稿、工作区或历史样例；结束恢复310px右栏和暗色，保留分支提交详情展开。

## 浏览器证据

[10个状态](cases.json)保存实际DOM测得的摘要、详情、颜色、行与SVG几何、节点和图线段坐标；同名txt保存AX。[14项断言](checks.json)通过，包含下列行为。

- collapsed中6行全部折叠，摘要无时间与短哈希。refs在主题之前，分支、tag及HEAD可从按钮名称读到，父关系仍在列表中可读。
- merge-open为鼠标展开合并提交；multiple-open与修正读屏名称后的multiple-open-accessible为合并与分支两个详情同时展开，父列表、时间及短哈希正确，各行互不影响。
- tag-open用Enter收起合并提交并展开tag对应提交；Space也能展开与收起。关闭行的详情内容从DOM移除，元数据留在对应展开详情中。
- narrow-dark及narrow-light将右栏缩到260px，详情完整主题与字段可换行；标签前景色与对应节点／分支线的实际computed stroke相等。最窄摘要宽236px，图线与后续行持续对齐，未产生原生title。
- final-dark、final-restored与final-accessible恢复310px暗色右栏，只展开offline-cache提交；提交主题、作者、2026-10-16、c24d8e6及父提交4b7a1d0可见。最终AX含HEAD、分支和tag的完整按钮名。

[动画抽查](motion.json)记录开／关起点与按住Enter 60ms后的中间帧：分支行由189.5703125px收至163.9609375px，最终关闭高度为56px；中间帧SVG仍覆盖实际行高，摘要节点保持cy=28，后续行无间隙接续。稳定状态每条跨行线的坐标与颜色也逐一接上下一行，节点与摘要中心误差小于0.05px。

截图：[最终暗色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-commit-details%2Ffinal-dark.png)、[最窄暗色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-commit-details%2Fnarrow-dark.png)、[最窄浅色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-commit-details%2Fnarrow-light.png)、[多个详情](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-commit-details%2Fmultiple-open.png)。前两个状态在移除覆盖refs的aria-label之前采集，视觉与布局结论有效；collapsed及其后状态均含最终自然读屏名称。页面控制台无error／warn。

## 工程范围

demo check（类型、SSR自检、构建）与全仓check:static通过，保留既有大于500kB的构建块提示。SSR覆盖每行默认折叠、refs顺序、摘要无时间／哈希、图边不漏、动态SVG无viewBox、详情字段／合并父／根及文本转义。仓库资格与空态原自检继续通过；App入口、fixture和DAG函数未变，沿用[上轮仓库可见性证据](../git-graph/README.md)。

独立审查要求移除覆盖分支／tag／HEAD的摘要aria-label，已修正并加入SSR回归，最终实际AX确认。shadcn CLI曾加入多余cn依赖，已卸载并改用本地cn，package与lock无最终变更；未新增依赖。首次对不可聚焦body发送主题快捷键无效，改从当前提交按钮发送后验证成功。

真实Git、正式Desktop、其他内核和大历史性能未验收；所有提交仍为只读样例。本轮只读详情，无checkout、fetch、提交编辑或后台接线。独立最终结论归[工单18](../../issues/18-git-commit-details.md)，拥有者审阅图形观感，未提交。

随后拥有者改为只有左图标区取lane色、文字中性且无标签外框；[新标签证据](../git-ref-tags/README.md)替代本文的文字同色结论。本文保留该调整前的实际状态，详情交互和图线动效继续有效。
