# Git graph 自动续页验收

日期2026-10-17，macOS arm64、Node v24.15.0，基点53fad806549622b2fb599550a79beff08cadc130之后的未提交Desktop迁移与本轮差量；源码和证据指纹见sha256.json。工单见[22](../../issues/22-git-lazy-loading.md)。本轮没有协议、后台或Demo样例改动，不提交、不推送。

## 行为与回归

正式GitGraphPanel移除正常加载按钮，以历史滚动容器内的末尾观察点提前224px读取下一页。隐藏／离线、刷新／追加中和两类错误停止观察；追加错误显示重试，刷新错误沿用刷新按钮。每代Observer至多触发一次，清理后通知失效，cursor改变后重新观察以处理追加后仍交叉；同cursor的无关重渲染不重建观察，回调保持最新。

`observer-repro.mjs`执行实际组件源码中的effect，替换React挂载与Observer边界。旧实现失败见red.log，新实现通过见green.log；覆盖重复通知、回调更新、隐藏、错误／重试、刷新、最终页与卸载。`test/desktop-git-lazy.test.ts`固定调用该回归。它不证明浏览器几何行为。

## 真实浏览器

通过现有Demo开发服务同源的临时HTML加载fixture.tsx，fixture导入正式GitGraphPanel与正式CSS，用200／200／5的405条受控数据及150ms受控延迟代替后台。使用真实浏览器End键滚动和真实IntersectionObserver；首次顶部200条／0次请求，模拟一次失败后停在200条／1次请求（failure.json）；点击重试追加到400条／2次（retry.json）；再次End追加至405条／3次，再次End请求数仍3、无错误及加载更多按钮（final.json、final.png）。数据与请求次数是fixture结果，不是实际Git仓库／后台性能数据；真实后台分页与Inspector归属继续由既有回归覆盖。

先尝试临时5187端口时浏览器拒绝该URL，随后使用现有5173服务同源验收页；未更改浏览器安全设置。临时HTML、验收标签与5187测试服务已清理，两个原用户标签未操作，日常Demo／后台未重启。fixture.tsx保留为可复用的浏览器验证入口，复验时可从Demo根的临时HTML通过Vite绝对文件导入该文件，完成后删除临时HTML。

## 工程检查与审查

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npx tsx --test test/desktop-git-lazy.test.ts test/desktop-demo-v4.test.ts test/desktop-inspector-tools.test.ts` | 43／43 | targeted.log |
| `npm run check:static` | 通过，含lint／类型／notes／docs | static.log |
| `npm run check:docs` | 最终文档、工单和证据说明通过 | docs.log |
| `npm --prefix .scratch/desktop-shadcn/demo run check` | 通过；已有大chunk提示 | demo.log |
| `npm run desktop:mygo:build`、`npm run desktop:build` | 均通过 | mygo-build.log、electron-build.log |
| `codesign --verify --deep --strict` | 两个bundle均exit0 | signatures.json |

独立方案审查与实施审查无阻断；审查者亲跑effect与SSR／Inspector共10项通过。根为本checkout唯一写入者。

原生MyGo滚动体验未实测，巨大累计历史仍没有DOM帧率保证；恢复原生交互环境后由拥有者复验。此次只改变续页触发，没有新增依赖或协议版本。
