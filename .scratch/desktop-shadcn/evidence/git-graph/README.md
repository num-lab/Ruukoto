# Git graph 验收

环境：2026-10-17，127.0.0.1:5173 可变 GUI demo，用户已有 IAB 标签，默认视口约855×827，未设置视口覆盖。右栏默认310px，实测调宽至390px进行标签拖动，再缩至最小260px检查排版，结束恢复310px与暗色；清理本轮临时打开的PA／eval／menubar主标签，原三个会话保留。

## 实际浏览器

[16份状态测量](cases.json)保存入口、标签数量、面板文本、节点位置、父边路径及实际解析颜色；同名txt保存完整AX。[12项断言](checks.json)全部通过，另有[最终读屏与对齐检查](accessibility.json)。

- fumo-entry有Git graph入口；fumo-open以独立标签显示6提交、6父边、HEAD／分支／tag、作者、日期与短哈希。fumo-dedup重复打开后仍为1个Git标签。
- non-git-eval没有入口、标签或面板，即使此目录原有工具差异；pa-no-git同样不提供Git能力。未知与新工作区资格另由纯函数自检覆盖。
- nexus-open显示独立的3提交线性历史，fumo-restored返回原6提交图，文本与先前相同；没有跨会话混用历史。
- empty-repo-entry仍提供入口，empty-repo-open展示macos-menubar-kit与「暂无提交」，没有节点或父边；见[空仓库截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-graph%2Fempty-repo.png)。
- graph-tab-dragged把Git标签拖至首位，面板保留；graph-tab-closed移除标签及面板，graph-tab-reopened恢复且去重为1个。关闭后的相邻diff仍显示原内容。
- narrow在260px右栏保留6行，所有节点中心与对应56px行中心误差小于0.05px；其他有提交的状态同样对齐。父边颜色均实际解析，没有无效var或none，所有面板均无原生title。

[暗色最终界面](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-graph%2Fdark.png)、[浅色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-graph%2Flight.png)、[最窄右栏](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fgit-graph%2Fnarrow-dark.png)均为真实界面截图；最终完整可访问树见[final-accessible.txt](final-accessible.txt)。图中数据明确标注只读样例，不表示真实仓库或真实历史。图线由父关系计算，提交行仅展示，没有Git写操作。

## 工程检查与范围

实施者运行demo check（类型、render自检、Vite构建）、全仓check:static及diff检查；结果记录在[工单17](../../issues/17-git-graph.md)。沿用原有大于500kB的单块构建提示，未增加依赖。定向自检覆盖线性、合并／分叉、octopus共享父、多根与窗口外父边，逐边核对实际父子端点、输入不变、样例拓扑顺序、SSR节点／边与元数据、空态、转义、无悬浮title，以及合并／根／窗口外父关系的读屏文本。

独立首审发现新增原生title与旧约定冲突，已删除并加入SSR回归；首次SSR边数把Lucide图标路径计入，已将断言限制到提交图SVG，修正后通过。读取SVG几何的第一次QA遇到浏览器DOM代理不提供viewBox.baseVal，已改读viewBox属性重测；这不是界面错误。页面控制台没有error／warn。独立最终审查见工单。

最终复核发现父关系仅由aria-hidden的SVG表达，已追加不影响视觉的读屏文本并加入定向自检；final-accessible实际AX读到合并的两个父提交及根提交，六行节点仍精确对齐。前15个状态保留当时记录，第16个状态与最终暗色截图在此修复后采集。

没有读取真实本机目录或执行Git，不验收正式Desktop、其他内核、大历史性能、仓库检测或实时历史变更；这些均未作为通过项。本轮不新增搜索／checkout／fetch／提交详情，拥有者审阅图形观感后再决定迁移；未提交。
