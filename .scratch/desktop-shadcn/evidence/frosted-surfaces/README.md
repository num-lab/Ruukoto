# 左栏与顶部标签毛玻璃验收

环境：2026-10-17，127.0.0.1:5173可变GUI demo，用户已有IAB，855×827视口。轻量局部样式修订，复用reference.css已有28px模糊和160%饱和滤镜；仅新增目标表面72%语义色底、支持滤镜时的透明窗口底及减少透明度回退，不改布局、交互、全局主题变量或背景内容。

[原状态](before.json)中两表面虽有blur但底色与窗口底均不透明；[暗色](dark-open.json)与[浅色](light-open.json)实测两表面alpha为0.72，filter为blur(28px) saturate(1.6)，窗口透明。共同48px顶栏包含36px会话标签容器和48px右栏标签容器，两者透明且位于共同玻璃区域内；不叠加第二次滤镜。主画布与右栏正文仍为原实色。

[9项断言](checks.json)全部通过，闭合状态的[最终几何](final-closed.json)与原状态逐项相同。左右栏开合、[设置弹层](settings-open.txt)与完整可访问树实际检查通过；首次设置与左栏检查期间开发热更新恢复了初始右栏状态，等待源文件与构建稳定后已重测通过，见[left-restored.txt](left-restored.txt)。最初误把内部会话标签高度也当作48px，已改按共同顶栏的包含关系校验；该容器原为36px，并非布局变化。[控制台](logs.json)无error／warn。

截图：[暗色双标签区](dark-open.png)、[浅色双标签区](light-open.png)、[恢复原闭合状态](final-closed.png)。结束恢复暗色、左栏展开及原右栏收起状态；无新浏览器标签、无草稿修改。底层为现有纯色，未添加纹理或壁纸，因此这里只验证半透明、滤镜启用与文字可读，不声称复杂背景下的光学效果。

demo check、check:static与diff检查通过，保留原有大于500kB的构建块提示。tab_avoidance_review独立只读复核无阻断，亲跑diff与前后几何／明暗样式／两标签覆盖断言通过。unsupported与prefers-reduced-transparency的实色回退由代码复核，未切换真实系统偏好或换不支持滤镜的浏览器；未验收原生Desktop毛玻璃、其他内核或GPU性能，无新增依赖，未提交，拥有者审阅观感。
