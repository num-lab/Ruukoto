# Git graph 紧凑行验收

环境：2026-10-17，用户已有IAB的可变demo，855×827视口，右栏260px，未改视口或侧栏宽度。只打开临时Nexus Git标签做双标签检查，结束关闭该标签，返回原Fumo会话并收起全部提交详情。

[4个实际状态](cases.json)及同名AX保存28px摘要、SVG、节点、父边与标签几何；[9项断言](checks.json)通过。fumo-collapsed与final的6行高度均为28px、节点位于摘要14px中点，摘要右侧无图标；源边从14px连到28px行底，跨行竖线连续接入下一行。[最终截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-compact-rows%2Ffinal.png)显示紧凑密度。

fumo-expanded用Enter展开分支提交，摘要仍28px，详情正常显示作者、时间、短哈希和父提交；SVG随实际行高延伸，后续节点保持14px中点，跨行边无间隙。Space收起后详情内容移除，见[展开截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-compact-rows%2Fexpanded.png)。nexus-narrow的两个标签保持单行18px高，图标块与origin后缀均在标签内可见，无跨行重叠；长名称允许省略，AX仍含「分支 HEAD → main 远程分支 main origin」和完整主题，见[双标签截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-compact-rows%2Fnexus-narrow.png)。

demo check、check:static与diff检查通过，定向SSR会在恢复56px或右Chevron时失败。图标配色、只读仓库资格和未改的详情交互沿用[图标标签证据](../git-ref-tags/README.md)，本轮取代其中56px摘要／38px标签换行的当前尺寸结论。不重复浅色主题、真实Git、正式Desktop或大历史验收，未增加依赖、未提交；独立复核归[工单18](../../issues/18-git-commit-details.md)。
