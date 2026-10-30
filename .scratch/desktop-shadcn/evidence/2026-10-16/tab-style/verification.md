# Demo 标签关闭叠加与短分隔线

本轮在上一轮未提交 demo 调整上，仅修改可变 demo 的局部 CSS、README 与既有顶部布局笔记，不动 Desktop、后台、冻结稿或原语。拥有者追加要求分区线不要占满高度，最终为 48px 标题区内垂直居中的 28px 线，收起右栏时隐藏。[源码哈希](source-hashes.json)记录本轮最终内容。

`npm --prefix .scratch/desktop-shadcn/demo run check`、`npm run check:static` 与 `git diff --check` 通过；追加缩短分区线后另行通过最终 demo check。独立只读实现复核及短线追加复核均无阻断，不为局部样式新增永久测试或依赖。

独立 Playwright CLI 浏览器在 1280×827 核对：默认选中标签关闭键透明、标题无 mask，左右 padding 为 10px；悬停关闭键透明度 0.8、仅标题有渐隐遮罩，标签／触发器／文字的布局宽度不变。选中中间会话后，其自身与后一标签的分隔伪元素均隐藏。右侧标签也通过悬停及关闭键键盘聚焦检查；收起右栏后分区线隐藏。833×827 下短线仍为 28px，关闭其他两项后，最后一个会话关闭键禁用、悬停文字不渐隐。检查函数全程断言通过，早期因固定 Agent 名称、隐藏按钮的 role 过滤及刷新前窄视口初始化造成的定位失败不作为通过依据。

实际截图：[默认](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Ftab-style%2Ftabs-default.png)、[悬停](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Ftab-style%2Ftabs-hover.png)、[浅色](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Ftab-style%2Ftabs-light.png)、[顶部局部](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Ftab-style%2Ftab-header-hover.png)。截图检查确认悬停文本渐隐与短分区线；控制台只有此前已有的 favicon.ico 404 与开发提示，没有新增应用错误。当前 in-app demo 另行读回分区线 28px、标题区 48px、标签右 padding 10px。

本轮未提交或同步 Desktop；Playwright 临时脚本与浏览器配置保留在系统临时目录，验收后关闭独立浏览器，不关闭用户已有标签。
