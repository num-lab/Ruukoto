# 工具组合验收

日期：2026-10-25；验收基点83f212ad，源码与本记录同批提交。环境：macOS arm64、Node24.15.0；使用隔离临时档案、真实 Runtime／Driver／worker、本机 mock provider／HTTP／MCP，以及桌面 DOM 夹具。最终文件哈希见 [source-snapshot.json](source-snapshot.json)。

## 作者验收

| 检查 | 结果与证据 |
| --- | --- |
| search、fetch、present、进程 wait、125-resource、58-Plan、62资格、64账本 | 48/48，[integration.log](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tools-next%2Fevidence%2Fintegration.log) |
| 07真实工具、08审批、10模式、63闸门、90族、桌面检查器／工具活动／浏览器安全 | 151/151，[routing-desktop.log](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tools-next%2Fevidence%2Frouting-desktop.log) |
| 09产物、38桌面构建约束 | 17/17，[artifacts-build-tests.log](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tools-next%2Fevidence%2Fartifacts-build-tests.log) |
| 全量静态检查 | `npm run check:static`通过，[static.log](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tools-next%2Fevidence%2Fstatic.log)；曾因新增导航重复造成文档超预算，已移回既有检查集，不抬高预算 |
| worker／脚本／原生／workspace构建 | `npm run build`通过，[build.log](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tools-next%2Fevidence%2Fbuild.log) |
| Electron、MyGo正式构建 | 两者通过，[desktop-build.log](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tools-next%2Fevidence%2Fdesktop-build.log)、[mygo-build.log](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tools-next%2Fevidence%2Fmygo-build.log)；均通过 `codesign --verify --deep --strict` |
| 生产依赖 | npm离线重算锁文件，parse5与其entities不再标dev；`npm ls parse5 --omit=dev --all`及锁文件断言通过，版本未变 |
| 行尾与差异 | `git diff --check`通过 |

新增接口未引入数据库或控制协议迁移，未改真实用户档案。首次 MCP 测试中的原直接调用场景已更新为真实 search_tools 握手；图片／请求快照断言按实际工具定位，失败不是跳过或放宽权限。等待原生/TUI隔离副本的一次并发时序抖动单测复跑通过；融合后的最窄组合全部通过。

## 独立实现审查

- search：fetch_path 审查实现与 SDK 生命周期，亲跑17项搜索／子任务与49项MCP回归；补充同任务资源恢复、签名变化SDK重建、无搜索入口的固定角色真实调用实验。无剩余阻断；[原审查记录](search-review.md)。125冷启测试新增搜索轮的计数由3修正为4，复验通过。
- wait：preview_landscape 亲跑后台／125-resource 20项及恢复／账本33项，唯一计数断言问题同上，融合组合已覆盖。真实短命令退出→attention、显式stop→wait→同轮write、新输入和取消保留后台、旧工具名和同call ID混合结果的报告消费均通过；无剩余阻断。
- web_fetch、present：tool_landscape 亲跑82项，涵盖真实HTTP、真实worker、DOM检查器和工具行。发现206误标完整的P2后，作者将206统一为partial并新增/range回归；复审通过。文件只读任务产物、空文件、URL资格、live／重放及会话归属无剩余阻断。
- 文档：fetch_path 核对四篇决定与模块文档，指出内部对话／后台观测资格及 stop_requested 条件须区分；正文与 wait 描述同步后复审通过，无剩余文档阻断。

## 模型输入估算

同一 web_fetch 夹具的独立候选与最终组合：toolSchemas 13295 → 14291，systemPrompt 1503 → 1502。候选已包含web_fetch；这不是原始基点的全工具比较。

最终搜索夹具初轮与激活一个MCP后的下一轮：toolSchemas 10617 → 10734，systemPrompt 1502 → 1502。实际provider请求及prompt产物同时断言定义变化，搜索结果只给名称和描述，避免重复schema。

## 验收结论与缺口

工程验收通过。产品验收待拥有者在真实Electron／MyGo中确认自动打开及历史重开体验；DOM通过和正式构建不代替此项。真实模型、外部MCP／网页嵌入、Linux运行未执行；未运行全仓 `npm run check`。文件沿现有格式，HTML为源码、PDF/SVG不支持；网页预览需完全访问，正文提取只支持静态UTF-8，服务压缩与动态页面需可用浏览器。

拥有者已授权提交；未推送、部署或切换用户实例。下一责任人为拥有者，体验验收入口为主会话分别调用present文件／网页、从历史重开；真实模型可沿既有smoke开关独立执行。
