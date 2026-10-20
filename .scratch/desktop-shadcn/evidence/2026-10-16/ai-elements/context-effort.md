# Context 与 Effort 验收

按最新需求，仅修改独立 demo：模型左侧是只读 Context 图标与百分比，右侧是 Effort Select，再右侧为发送按钮。Context 提供 meter 的已用／总 token 可访问值，不增加悬浮说明；32,000／200,000 为固定模拟数据，不表示模型真实容量。Effort 为 Low、Medium、High，默认 Medium，使用既有 shadcn Select 和 composer-menu。

Session 保存 Effort 与 Context。普通新会话和新增工作区的首个会话都继承当前 Effort，上下文从 0 开始；模拟提交不改写用量，核实期间禁用模型和 Effort。正式 GUI、后台、冻结稿、原始样例快照、官方组件源码及依赖均未改变。新增字段触发过开发热更新旧状态缺失，重载 demo 后恢复；没有增加持久化迁移或兼容支线。

工程：`npm --prefix .scratch/desktop-shadcn/demo run check` 和 `npm run check:static` 通过。SSR 覆盖控件顺序、0／16／50% 数据驱动显示、读屏用量一致、核实时禁用，以及提交保留字段。独立方案与实现复审无阻断，审查者亲跑 demo check。浏览器发现最窄布局的 grid 被旧 flex 规则优先级覆盖，修正选择器后重新构建通过，并按实际尺寸复核。

浏览器：原生 974×827 下排列为 Context → 模型 → Effort → 发送；菜单上弹且不覆盖选择框，进入位移为 0。A 选 High → B 仍为 Medium → A 保留 High；两个新建入口均继承 High 且显示 0%。输入核实时草稿仍在、模型与 Effort 同时禁用。760×500 双侧栏打开并调整到主栏 220px、操作区 144px 时，三个控件同排，发送另排靠右，整页和操作区均无横向溢出。极窄栏保留 Context 百分比与可访问名称，仅隐藏装饰图标；模型名可截断。明暗主题均核对，临时视口已恢复，测试工作区／会话已通过重载清除。

效果见[深色菜单](context-effort-dark.png)、[浅色菜单](context-effort-light.png)、[最窄布局](context-effort-minimum.png)，测量见[数据](context-effort.json)。本轮无新依赖和后台调用，未执行真实模型或 Electron 验收；外观交拥有者审阅。
