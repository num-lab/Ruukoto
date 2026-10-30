# 当前 demo 迁入 Desktop：验收

## 范围与基准

[工单05](../../../issues/05-current-demo-migration.md)授权按当前 demo 迁移真实 Desktop。旧冻结稿 23 文件与 v2 冻结稿 41 文件哈希均一致，见[范围记录](scope-and-frozen.json)；1879 个原跟踪文件基线内的变动均在约定范围。正式 CSS 以 v2 完整前缀起始，全部原语仅规范化相对 import，theme／reference／resizer／utils 精确匹配。旧工单、旧证据和原 demo 保留。

## 工程检查

- Desktop 直系 main／Personal／build／recovery／creation／stream／inspector、附件、Agent、Context、Composer 及工作区只读接口首轮 157 项通过，完整输出留在本会话工具记录，本目录未另存该轮日志。
- 新增基准／文件工具／Context／浏览器安全／构建／控制面组合 70 项通过；后续空消息修正后最终 renderer 39 项、main／Composer 67 项通过。各次测试只对当时受检内容负责，后续改动限空帧过滤与文档，没有因接近交付重复全量用例。
- `npm run check:static`、`npm run build`、`npm --prefix .scratch/desktop-shadcn/demo run check`、`npm run desktop:build` 通过；`codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` 通过。后续测试、静态、构建及签名日志保存在本目录 logs/。未运行全量 `npm run check`。
- 独立方案与实现复核完成。断线状态漏传、Context 在途新事件丢刷新、空 thinking／工具调用空正文留下外层间距均已修复，并保留最窄回归；纯附件的反分支仍显示。

## 实际 Electron 操作

使用[隔离夹具](electron-fixture.mts)启动真实 Runtime、ControlServer、工具 worker 与 Electron 生产 renderer，独立 userData、控制目录和临时工作区；未对日常运行实例提交输入或重启它。夹具多次重启使用相同场景，ready.json／fixture-progress.json 属最终截图轮，backend-status.json 保留首轮交互状态，不作为最终截图轮的当前状态证明。模型为本地确定性 MockModelServer，Thought 的 5 秒文本是夹具显式写入的持久 task.thinking 事件，用于检验真实读取、耗时和折叠，不是 provider 输出。

通过原生 UI 打开真实会话，确认 Thought 默认折叠、展开实际事件文本；工具分类和 Wrench、13px 正常字重的内联 code、顶部右栏标签、短分隔线、独立差异与 Agent 历史显示。最终[主界面](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Ffinal-dark.png)没有空帧间隔。子 Agent 夹具等待期间真实请求超时，界面如实显示超时；本轮不把它记作成功完成的真实模型委派。

模型菜单包含实际 Mock Model 与 Off 档位，模式菜单显示四个模式；点击 Auto review 后回读实际会话值。Context 打开后显示最新选择记录的约 87.5K／1M 与三分类，环形入口无数字，见[明细](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fcontext-dark.png)。键盘将右栏从 375 调到 599，使消息区变窄，模式与模型收为图标、功能键保持单排；恢复原宽度并切明暗，见[窄栏](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fnarrow-dark.png)和[浅色](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Flight.png)。本轮鼠标调整原生窗口外框没有稳定改变尺寸，不将该尝试记为通过。

28 个真实任务生成 56 条用户／回复历史，首次窗口从 gui-scroll 03 开始。向下再向上滚动后 AX 新增 gui-scroll 00～02，补页前后 gui-scroll 03 与正文保持原阅读位置，见[补读前](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fhistory-before.png)与[补读后](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fhistory-after-prepend.png)。在该位置发送新输入，接收后输入清空而阅读仍停 gui-scroll 03，见[新消息不抢位置](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fhistory-new-message-stays.png)；滚动到底部后再发送 follow-bottom，最终停在新回复末尾，见[底部跟随](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fhistory-follow-bottom.png)。这些结论结合实际输入、滚动与 AX 观察，截图不是自动几何断言。

文件树来自注册工作区；实际打开 README 的 Markdown 及源码，PNG 显示图片，PDF 显示不支持，空文件保留空源码。点击 Markdown 中本地链接打开浏览器，地址栏导航、后退和前进可用。远程子框实际报告 bridge=undefined、node=undefined、geolocation=denied；点击 Popup 与 Top navigation 后桌面主 frame 保持原 file URL，未打开新窗口，见[隔离页](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fbrowser-isolation.png)。静态图只显示隔离页结果，不单独证明上述点击发生。

实际待审批卡使用真实参数，点击拒绝后卡片立即移除；[卡片](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fmigration-v2%2Fapproval.png)有独立背景、没有额外图标和线框。圆形附件按钮打开系统选择器，选取当前临时工作区 clock.txt 后显示附件，纯附件提交经真实控制面接收，清除输入并在消息中显示附件名。原未知应答与恢复语义由定向回归覆盖，本轮未通过人为断网重新演练。

## 限制与交接

真实 provider、真实 SSH、开发模式 HMR 与外站可嵌入性本轮未验。浏览器保留 demo 的 iframe 限制，不能替代完整浏览器；网页内部导航不计入地址栏历史。目录单层显示 200 项、文件预览 256 KiB，截断与不支持如实呈现。协议升级到 28，旧后台需要更新后才能连接。

构建产物已更新并签名，日常正在运行的旧应用／后台未被自动替换或重启。后台暂缓 UI 清单继续有效，未迁入演示数据、演示设置或额外管理界面；没有提交、推送或发布。工程与交互验收完成，最终主观一致性由拥有者审阅。

提交准备：拥有者随后要求「提交」，仅授权本地提交，未要求推送。暂存检查发现此前未跟踪的参考 CSS、构建日志和 AX 文本有行尾空白；仅删除行尾空白，CSS 四个副本同步处理，非空白内容逐字一致。两份冻结稿 manifest 与本轮 source-hashes 已更新；历史验收的 source-hashes 保留原值，参考 CSS 原 SHA-256 为 `53f9b06e89db59dfebe2fbe4e58c84c685412e8048e80804c0992093da28f651`。临时夹具 command 文件不入库。
