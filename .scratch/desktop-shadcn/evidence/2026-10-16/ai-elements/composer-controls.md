# 输入区图标与紧凑 Context 验收

2026-10-16，仅修改可变 demo 的局部视觉。附件按钮仍为原 26px 入口，圆角 50%、底色在 muted 上混入 12% 白色、加号 stroke=2；四种模式在菜单和入口使用同源图标，320px 以下仅保留图标并保留可访问当前值；Context 为 280×137.56px，环形中心距弹层左边约 29.5px，边缘碰撞避让时自然窗口为 32.22px。

`npm --prefix .scratch/desktop-shadcn/demo run check`、`npm run check:static` 和 `git diff --check` 通过，构建只保留原 500 kB chunk 提示。SSR 补四种模式图标及当前值／描述回归，独立只读复核亲跑 SSR 通过，无阻断。

浏览器亲验 Ask for approval、Auto review、Full access、Plan 均可切换并显示对应图标；菜单标签完整，窄入口隐藏文字及箭头但读屏仍有当前值，图标 14px。附件颜色比 composer 浅、尺寸仍为 26×26px、圆角及笔画符合要求。自然 833×827 和临时 760×500、144px 最窄操作区均无水平溢出，五个按键纵坐标差不超过 1px；280px 弹层完整可见。灰／紫／蓝与三行明细保持一致，键盘聚焦仍可打开详情。控制台 error 列表为空。

[最终效果](composer-controls-final.png)、[局部效果](composer-controls-closeup.png)、[深色](composer-controls-dark.png)、[浅色](composer-controls-light.png)、[最窄操作区](composer-controls-narrow.png)与[测量／源码哈希](composer-controls.json)持有证据。临时视口、模式和侧栏偏好已恢复原默认样例；正式 Desktop、后台、冻结稿、数据、依赖及官方原语均与本轮前保护快照一致。

未重验原生文件选择器，附件 onClick、type、disabled 逻辑原样保留；未做 Electron 或真实后台验收。当前交拥有者审阅视觉。
