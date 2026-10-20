# Git ref 图标标签验收

环境：2026-10-17，用户已有IAB的127.0.0.1:5173可变GUI demo，默认855×827视口。右栏由310px缩到260px检查，再恢复310px与暗色；清理本轮临时打开的Nexus Git标签，主会话标签保留，最终回到Fumo并展开offline-cache提交。未改草稿或执行Git。

[7个实际状态](cases.json)保存每行摘要／节点位置、图线颜色与标签computed样式，同名txt保存AX。[14项断言](checks.json)全部通过。

- fumo-dark显示分支图标、Tag图标及独立origin后缀。所有标签图标块底色等于对应节点及线条stroke，图标使用对比色，标签名称统一中性色，最外四边border均为0px；origin内部左线1px、斜体。
- nexus-same-name记录首次实现中两标签被压窄的情况；修改refs内部换行后，nexus-wrapped与[名称测量](nexus-visible-names.json)确认两个main都保留。
- nexus-narrow在260px右栏保留两标签；[几何测量](nexus-narrow-geometry.json)中refs高38px、摘要高56px，两个名称均未截断，图标块和origin后缀都在各自标签可见范围内。见[窄栏双标签](nexus-narrow.png)。
- fumo-narrow-dark与fumo-narrow-light检查[最窄暗色](narrow-dark.png)和[最窄浅色](narrow-light.png)；图标块跟随主题语义色变化，名称继续为中性色、无外框。所有状态摘要高56px，节点偏移28px，标签先于提交主题。
- [最终界面](final.png)只展开分支提交，完整主题、作者、2026-10-16、c24d8e6与父提交仍可见。[最终AX](final.txt)的自然按钮名含「分支 HEAD → main」「远程分支 main origin」与「标签 v0.3.0」，没有依靠颜色或图形传达类型。页面控制台无error／warn。

demo check、check:static及diff检查通过；保留已有大于500kB的构建块提示。定向SSR覆盖显式branch／tag图标、同名本地和远程分支、类型不靠v前缀猜测、name／remote纯文本转义、refs顺序、默认折叠及详情字段，原仓库资格／空态／DAG继续通过。无新依赖，生产代码与package／lock无diff。

本轮接续[提交详情证据](../git-commit-details/README.md)，替代其中标签文字取lane色的样式结论；未改的详情多开、键盘操作、动画和动态行高连接沿用该轮证据。真实Git、正式Desktop、其他内核与大历史性能未验收。独立最终审查归[工单18](../../issues/18-git-commit-details.md)，拥有者审阅标签观感，未提交。

后续拥有者要求行高减半并去掉右箭头，[紧凑行证据](../git-compact-rows/README.md)取代本篇56px摘要与38px双标签换行的当前尺寸结论；本篇仍保留当时的配色和类型验收事实。
