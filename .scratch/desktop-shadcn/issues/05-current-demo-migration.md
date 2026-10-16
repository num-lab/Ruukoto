# Desktop 按当前 demo 更新

Status: ready-for-human

## 目标与授权

拥有者于 2026-10-16 要求「现在按照demo修改desktop的ui」，授权将当前可变 demo 的布局、样式和交互迁入正式 Desktop。[新冻结稿](../approved-demo-v2/)与[哈希](../approved-demo-v2-manifest.json)持有本轮依据，旧冻结稿和旧验收保留。沿用之前严格一致、不自行增加内容的要求；后台已有而 demo 未体现的能力继续列在清单，不恢复旧诊断或管理 UI。

## 实施方案

展示层复制本轮原语、Neutral 主题和 CSS；保留原生交通灯／拖动区，真实 Markdown 和所有提交／审批／恢复状态。消息、工具组、Agent 和审批使用同版 AI Elements，真实 thinking 直接展示既有文本与时间戳；工具分类覆盖真实 bash，不编造工具耗时。滚动使用官方 Message Scroller，补读历史仍保留既有锚点，只有一个跟随控制者。

顶部右栏标签与 aside 共用宽度、收起与焦点，保留单次调用差异、more 和 Agent 历史。新增浏览器、文件树及文件预览与 demo 同版布局。浏览器使用无 same-origin／顶层导航／弹窗／下载的 sandbox iframe，仅接受无凭据 HTTP(S)，初始空页；不迁模拟车票、默认网址或文件样例。生产及开发 CSP 仅增 iframe HTTP(S) 与预览图片 data 来源，脚本 nonce、主页面导航保护、IPC 主 frame 校验、远程页面无 bridge 保持。

文件树／预览只读接口仅接受已登记工作区 ID 与相对路径，后台决定根目录，复核目录身份、保护根、路径与符号链接、普通文件、大小和读取前后状态。目录按层读取并有界，内容只返回文本／Markdown／图片或明确不支持；缺失与失败沿现有空态／重试样式，不增加编辑、搜索或下载。正式模型与文件列表必须真实，不迁 fixture。

输入区复制圆形附件、四模式图标、单排响应式与模型／Effort 组合菜单，Effort 使用目录真实 thinkingLevels，所有设置复用 CodeWrites 版本和未知结果核实。Context 放行已有两个只读入口，使用最新落盘 prompt 选择记录的估算与当时窗口；无记录／容量／错误如实显示未知，不使用模拟值、当前目录替补旧容量或 provider usage。三类展示由 systemPrompt、toolSchemas 和其余已选输入组成，Messages 包含模型输入消息中的参考内容。所有读取按目标、实例、会话及异步代次隔离。

## 分工与影响

根代理唯一写当前 checkout，负责 renderer 展示、顶部／右栏状态、原语与依赖、构建安全和整体验收。文件接口与 Context 状态分别在两个既有干净独立工作副本实施，只汇入指定文件；汇总后重定向验证范围。主要涉及 desktop、必要 control／runtime 只读接口、定向测试、模块文档、决定与证据；不提交或推送。

## 验收

新旧冻结稿哈希各自保持；正式基础 CSS 和原语逐字可追溯至 v2，仅追加 Electron／真实数据适配。运行 demo check、Desktop 直系定向测试、新只读／Context／浏览器安全回归、check:static、desktop 生产构建及签名。实际隔离 Electron 使用独立 userData 和真实协议 fixture，核对明暗、宽窄、历史补读／跟随、真实 thought、菜单／Context、审批／附件／核实／会话隔离、差异／Agent、浏览器隔离和文件预览。真实模型与 SSH 无前提时明确未验证，不使用日常实例写入验收。独立方案与实现审查无阻断后交拥有者审阅。

## 当前阶段

展示层及最小只读接口已完成，独立方案／实现／最终截图复核无阻断。原业务提交、审批、恢复和实例隔离语义保留；后台暂缓清单继续有效。新旧冻结23／41项哈希、基准来源、定向回归、静态检查、构建与签名通过。

实际隔离 Electron 已核对明暗、窄消息区图标与单排工具栏、Thought、模型／Effort、Context、文件树／预览、浏览器隔离、历史补页／跟随、拒绝审批与纯附件提交。范围、步骤、证据及未验项见[验收记录](../evidence/2026-10-16/migration-v2/verification.md)。日常应用／后台未重启；没有提交或推送，交拥有者审阅最终体验。
