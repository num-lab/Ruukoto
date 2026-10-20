# 文件树反馈、入口删减与侧栏按钮验收

日期2026-10-17，macOS arm64、Node v24.15.0。基点53fad806549622b2fb599550a79beff08cadc130后的未提交迁移、既有修复与本轮差量，源码及证据指纹见sha256.json；工单见[23](../../issues/23-files-sidebar.md)。不提交、不推送；协议和后台行为不变。

## 文件树与新标签页

`file-tree-repro.mjs`加载正式组件，调用实际文件夹事件处理并SSR渲染；用受控目录缓存与读取接口替代后台。旧版首读文字准确失败（files-red.log），新版覆盖首读状态图标、等待期间不展开、行末图标、取消意图、缓存命中、刷新保留内容、错误／重试入口、空根／子目录留空和新标签页删减（files-green.log）。它不证明真实浏览器几何或宿主读取速度。

真实浏览器用files-fixture.tsx加载正式WorkspaceFiles、CodeState／DesktopInspector及正式CSS，只替换bridge回复：根读取中文字为空且一个加载图标（root-loading.json）；src点击后busy=true、expanded=false，无子项，图标距行右边6px（folder-loading.json、folder-loading.png）；完成后出现main.ts，empty展开无空文案，broken失败可见错误（files-success-empty-error.json），点击重试时回到收起和图标，成功后expanded=true、图标与错误消失（files-retry.json）。这证明正式前端交互，不是实际后台时延数据。

正式Demo的新标签页只保留浏览器／文件树／Git／SubAgent，无Git读取文字和工具差异清单（new-tab.json、demo-final.png）；正式Inspector的加载中和失败状态另由SSR确认，Git失败仍有alert与重试，已有diff与消息路径入口保留。

## 折叠按钮

`sidebar-fixture.tsx`加载实际Demo App和CSS，捕获正常点击前及每帧按钮x：旧版210→268→36，出现58px右跳（sidebar-red.json）；新版210→197→171→…→36，轨迹不向右跳，单按钮且保持焦点（sidebar-green.json）。手柄焦点Ctrl+B折叠后焦点回到同按钮、transition为0.2s（sidebar-keyboard.json）；连续三次Enter反向切换后仍只有一个按钮，收起且保持焦点（sidebar-rapid.json）。740px同源iframe给App真实子视口，170→28无右跳（sidebar-narrow.json）；该记录从可见output的AX文本读取，没有绕过浏览器DOM读取限制。来源SSR守住按钮只有一个且放在aside之前。

独立源码复核确认Demo16px／Native84px终点、顶栏30px按钮留白、no-drag、玻璃层、调宽与reduced-motion规则；原生几何未实测，源码推导不作为原生视觉结果。窄窗与键盘检查使用最终限定展开状态的调宽guard。

## 工程检查

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npx tsx --test test/desktop-file-tree-loading.test.ts test/43-desktop-demo.test.ts test/desktop-live-files.test.ts test/desktop-inspector-tools.test.ts test/desktop-interaction-regressions.test.ts` | 61／61 | targeted.log |
| `npx tsx --test test/desktop-file-tree-loading.test.ts test/43-desktop-demo.test.ts` | 最终3／3，含新增新标签页SSR | final-targeted.log |
| `npm run check:static` | lint／类型／notes／docs通过 | static.log |
| `npm --prefix .scratch/desktop-shadcn/demo run check` | 最终通过，已有大chunk提示 | demo.log |
| `npm run desktop:mygo:build`、`npm run desktop:build` | 均通过 | mygo-build.log、electron-build.log |
| `codesign --verify --deep --strict` | 两个bundle均exit0 | signatures.json |

独立方案及实施审查无阻断，实施审查者亲跑10项，样式审查者亲跑2项。根为唯一写入者；没有新依赖，没有修改冻结v4与共享原语。

两个本轮验收标签及三份临时HTML均已清理，两个原用户标签未操作，没有重启日常Demo、应用或后台。文件树bridge回复、目录缓存与Demo样例都是受控数据；原生MyGo鼠标、动画和实际目录读取体验未实测，恢复原生交互环境后由拥有者复验，保留原验收要求。
