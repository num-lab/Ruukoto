# 桌面问题卡片精简

2026-10-21，拥有者要求删除问题卡片无用说明、选项不用列表。本次只改桌面呈现：删除“每题都可以自由输入”及内部后续任务说明，终态只保留一次简短状态；已有Radix单选组配合Button直接展示选项，允许换行，Textarea始终可用。核对、取消、失败及未决提示保留，持久协议和TUI不变。

`test/desktop-composer.test.ts` 新增实际组件SSR回归，修复前因选项按钮数为0而失败；修复后覆盖无列表、默认不选择、选中/编辑文字清除选项、长选项全文、离线禁用及终态只显示一次。与 `test/owner-question-clients.test.ts` 共24条通过。`npm run check:static`、`git diff --check`及Electron三目标构建通过。`npm run desktop:mygo:build` 完成renderer、darwin/arm64应用及签名，未启动或重启日常窗口。独立上下文 `question_card_ui_review` 直接读最终改动，亲跑新增窄测1条通过，无阻断。

使用[既有夹具](owner-question-electron-harness.mts)启动隔离Runtime和隐藏Electron窗口，模型mock、CDP操作，未连接日常后台。实际验证点选→编辑文字后两项均未选→重新点选→重复点击取消选择，以及方向键移焦后Enter选择；继续逐题核对并提交，后台保存“共享”（option=1）与“简化界面验收”，仅原提问加一个续接任务。760×500窗口的[截图](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-inline-options.jpg)没有静态说明和下拉列表，卡片无横向溢出，诊断无新增异常。

长选项布局另在同一隔离窗口临时替换按钮DOM文字作纯布局探针，两项均换行增高且scrollWidth不超过clientWidth，随后恢复原文字；这不作为长选项提交证据，真实组件的长全文与选择语义由SSR和客户端用例分别证明。初次连续方向键/空格的值断言未通过，按实际焦点重新观察后，方向键移焦和Enter选择验证通过，没有重发提交。

原[组合验收](owner-question-acceptance.md)中的界面截图及文件摘要对应本次补修前版本；本次只替代桌面选项呈现、说明文字及相应测试/文档的结论，后端与模型证据仍有效。未重验前台IME、真实模型或全仓检查；没有提交或部署，也未切换用户前台窗口。

2026-10-21，拥有者追加要求：已回答的卡片应替换对应用户回答，不应始终堆在消息流底部。Desktop 按同会话的真实续接任务关联，在原用户消息位置显示卡片，底部排除已答卡片；待答、取消和失效卡片保留原入口。原历史和模型输入不改，不从正文识别回答。资料未加载或超出最近问题页时保留原用户消息，资料到达后原位更新；Personal、子会话和普通聊天不参与替换。复用原消息的滚动项，不重复登记。

新增 `Desktop 已答卡片替换对应用户消息并留在回答时序，不重复在底部出现` 回归，初次失败证明旧实现把卡片排在续接回复之后。修复后 composer、客户端、交互回归、trace hydration 和 tool activity 共48条通过；补充同文普通消息、资料先后到达、跨会话、子会话、Personal 与终态边界后，该窄测再次通过。缓存回归夹具同步新增组件依赖，性能回归通过。`npm run check:static`、Electron三目标构建、MyGo打包与签名验证通过。独立上下文 `question_timeline_review` 直接复审实现、测试、文档与笔记，亲跑窄测1条通过，无阻断。

在隔离Runtime与真实隐藏Electron窗口中实际选择、填写、核对并提交回答，确认卡片替换原回答气泡且只显示一次；继续发送普通消息，卡片仍位于先前回答的位置。`location.reload()`后同样成立，见[重载结果](owner-question-timeline-result.json)及[界面截图](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-timeline.jpg)。重载后旧GUI句柄超时，改用该隔离窗口的CDP读取DOM断言并截图，未重复提交。模型使用mock，本轮没有重验真实模型、前台IME或日常MyGo运行；验证后关闭隔离窗口及Runtime并清理临时探针。已重建本工作区MyGo产物，未启动或重启日常窗口，未提交、合并或部署。

2026-10-21，拥有者提供新参考图，桌面卡片改为顶部题号与问题、右上折叠和取消、编号全宽单选行、末行自由输入、底部左侧翻页与计数及右侧下一步的布局。只有选中行显示浅底与描边；长选项完整换行，选项文字不重复填入自由输入行。沿用每题必填、末尾核对后提交和取消确认，不新增参考图没有业务依据的跳题、推荐标记或选项副描述字段；已答卡片的原位替换不变。

`test/desktop-composer.test.ts` 新增实际组件的布局与三题导航回归，覆盖选项编号、可访问控件、空答禁用、翻页保留、无选项题、自由输入、最终核对及取消返回；与客户端用例共26条通过。`npm run check:static` 通过；文档和笔记更新后另跑 `npm run check:docs` 与 `npm run verify-notes`。Electron三目标构建、MyGo打包与签名验证通过。独立上下文 `question_card_ui_review` 直接核对代码、原参考图与实际截图，亲跑相关窄测3条通过，无阻断。

使用既有隔离夹具及真实隐藏Electron验证选择、自由输入清选项、折叠后点击取消展开确认、返回保留草稿、前后翻页和核对后提交。最终后台保存“共享”（option=1）和“参考布局验收”，只有原任务与一个续接任务；UI显示已答内容，诊断无新增异常。见[卡片截图](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-reference-layout.jpg)、[760×600视口截图](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-reference-layout-narrow.jpg)及[布局测量](owner-question-reference-layout-result.json)。长选项测量仅临时替换DOM文字，两种200字符的中英文选项均换行且无横向溢出，恢复原文后截图，不作为长选项真实提交证据。截图构建与最终构建仅相差核对和终态正文继承 `overflow-wrap:anywhere`，标准内容布局相同；最终Electron和MyGo产物均包含该规则。关闭Runtime后补采DOM时视图已清空，该补采未记为通过，未重复提交；本轮不声称重验断线恢复、真实模型或前台IME。隔离窗口与Runtime已关闭，日常应用未重启，代码未提交或部署。
