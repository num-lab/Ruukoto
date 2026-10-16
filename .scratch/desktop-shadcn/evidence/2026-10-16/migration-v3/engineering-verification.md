# Desktop v3 工程验收

## 基准与范围

[工单09](../../../issues/09-desktop-current-demo.md)授权迁移当前 demo，v3 冻结 45 文件，旧 v1／v2 分别 23／41 文件哈希保持。正式基础 CSS、主题、高亮器和原语按冻结稿来源核对；不迁模拟场景、文件、执行状态或额外管理入口。最终范围与哈希见 scope-and-frozen.json，实际 Electron 内容版本分别由三轮 source-hashes 文件持有。

## 检查

- Desktop 直系 16 个测试文件首轮 196／196 通过，见 logs/desktop-196.log；后续仅复核受影响的 renderer／事件流增量。最终流与 Trace 33／33、占位与预览 25／25、逐条引用门控 1／1 通过，分别见 logs/stream-delta-33.log、logs/scroll-render-final.log、logs/per-tool-entry.log，不累加重复用例。
- Write／历史 21 项在独立工作副本通过，合入文件逐字一致；独立审查者另亲跑其中 4 项，覆盖真实覆盖写入、空／缺失 patch、UTF-8 分页和最终 JSON 超帧仍保留成功。审批／执行边界回归 62／62 通过，见 logs/agent-62.log。
- 最终 check:static、root build、demo check、Desktop 生产构建和 codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app 均通过；对应日志在 logs/。没有运行全量 npm run check。签名为本地 ad-hoc，未做公证或发布。

## 独立审查与修正

独立方案与实现审查覆盖展示来源、真实任务阶段、参数／结果分页、Read 来源路径与异步代次、Write 历史、帧预算和 SDK 持久化时序。迟到 Read 跨父会话、可变工具对象导致详情不刷新、跨任务展开泄漏、未核实结果显示 diff 等均已修正；未知效果优先于普通失败，失败 Agent 调用同样能展开错误详情。

真实 Electron 验收发现 toolResult 已落盘但 output_entry 等到整批结束才发；修复后同批后续工具仍运行时前一结果可读。独立审查在隔离 Node 进程内分别撤掉逐条通知与任务代次护栏，门控回归准确失败于结果引用超时、下一任务消息身份被旧扫描消费；正向检查通过，工作区未为负例改动。

另一实际缺陷是手动 following 把懒尺寸的自动 scroll 误作用户离开末尾，造成 69px 缺口。逐帧记录保留，改用与 demo 同版官方组件统一跟随与 prepend 锚点，删除手写 scrollTop／观察器；加载占位移出 Content，避免提前消费 start。新方案经独立复审，最终 Electron 的初始位置、补页、自由阅读与连续末尾跟随另见 verification.md。

最终材料独立复核通过：103 项范围、68 项最终源码／产物、三版冻结稿与 14 张图的哈希均匹配；最新打包 app.asar 与 out 的 JS／CSS 逐字相同，签名另经审查者亲验。两次真实失败和修复轮次没有混记，隔离进程与临时资料独立确认清理。最终复核后仅回写工单状态与本记录，行为源码不变。

## 交接

日常应用与后台未替换或重启，没有提交或推送。新 Write diff 与逐条落盘通知须运行更新后的后台；旧历史缺 patch 仍明确不可用，未从当前文件补造历史。真实外部 provider、SSH 与外站嵌入条件未验证；UI 模型来自确定性本地服务，文件、工具、协议和 Electron 为真实执行。产品主观一致性由拥有者审阅最终截图。
