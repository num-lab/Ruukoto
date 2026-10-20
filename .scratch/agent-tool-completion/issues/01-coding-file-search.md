# Coding 文件发现与内容检索

Status: needs-info

## 目标与边界

交付[共享规格第1节](../spec.md#1-文件检索)的Coding切片；拥有者2026-10-21确认两端规划、先Coding。理由见[笔记](../../../.agents/notes/proposed/feature/2026-10-21-controlled-file-search.md)。不做索引、正则或运行时下载。

## 方案

1. 在agent新增共享文件检索参数/argv/解析模块；固定rg执行前提和预算。worker接收新工具、流式捕获、取消及停止，扩展protocol工具名和有界数据流；路径解析留在执行边界内。
2. ToolRouter/工具定义、账本无写入效果分类、可用性和Plan/只读子角色名单一起接入；driver额外过滤及workflow能力继承同步。核对package exports，已有通配导出足够时不增入口。
3. 将rg检测纳入现有setup/执行前提说明，检查缺失与平台依赖，不自动下载；若改命令或入口，同步README、docs/development和pre-push对应行。
4. 同步docs/modules/agent-tools.md、execution.md；新增入口留决策锚点，笔记实施后按实际事实转implemented。

影响路径：`packages/agent/src/{tool-router,tool-availability,tool-op-ledger,plan-mode,driver}.ts`、`tool-worker/{worker,protocol}.ts`、`execution/`及对应测试。实施前以实际符号重核，不按本列表机械改所有文件。

## 进展与交接

- 当前角色：方案者；revision2已通过独立方案审查，待拥有者审阅拟定契约。
- 下一角色：拥有者审阅方案并决定是否进入实施；范围确认后转ready-for-agent，由实施者接手。
- 当前内容：基点及未提交文件见[源码调查](../evidence/investigation.md)，审查引用[快照](../evidence/plan-review.md)。
- 阻塞：无事实缺口；未获得运行代码实施指令。

## 验收与证据

新增`test/file-search.test.ts`（拟新增）覆盖字面/大小写/glob、无glob时根内ignore/隐藏过滤、显式glob覆盖ignore/隐藏及不扩授权、全局配置排除、空结果、超长行、换行文件名、超时/输出预算、rg缺失和退出2。新测试须从实际worker入口覆盖，纯parser测试不代替执行范围。

扩展`test/07-real-tools.test.ts`、`test/62-tool-availability.test.ts`及实际受影响的`test/101-native-execution.test.ts`：越界根、目录替换、链接与保护来源负例，Plan/只读SubAgent允许搜索但不扩大范围。两个平台跑真实原生探针，Linux用ssh tx；缺环境记未验。

实施检查：`npm run check:static`、新增窄测及上述有实际影响的测试；改worker构建再跑`npm run build:worker`和制品用例。真实模型快照验收列文件→搜索→读命中并记录schema估算；不默认跑全量check。

工程验收：待验证。产品验收：待验收，核实路径、行号、过滤与截断是否足以指导下一步；方案审查见[审查记录](../evidence/plan-review.md)，没有运行结果。

## Comments

2026-10-21：拥有者要求制定方案；本工单不授予提交、部署或运行代码实施权限。
