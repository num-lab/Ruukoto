# Coding 文件发现与内容检索

Status: resolved

## 目标与边界

交付[共享规格第1节](../spec.md#1-文件检索)的Coding切片；拥有者2026-10-21确认两端规划、先Coding。理由见[笔记](../../../.agents/notes/implemented/feature/2026-10-21-controlled-file-search.md)。不做索引、正则或运行时下载。

## 方案

1. 在agent新增共享文件检索参数/argv/解析模块；固定rg执行前提和预算。worker接收新工具、流式捕获、取消及停止，扩展protocol工具名和有界数据流；路径解析留在执行边界内。
2. ToolRouter/工具定义、账本无写入效果分类、可用性和Plan/只读子角色名单一起接入；driver额外过滤及workflow能力继承同步。核对package exports，已有通配导出足够时不增入口。
3. 将rg检测纳入现有setup/执行前提说明，检查缺失与平台依赖，不自动下载；若改命令或入口，同步README、docs/development和pre-push对应行。
4. 同步docs/modules/agent-tools.md、execution.md；新增入口留决策锚点，笔记实施后按实际事实转implemented。

影响路径：`packages/agent/src/{tool-router,tool-availability,tool-op-ledger,plan-mode,driver}.ts`、`tool-worker/{worker,protocol}.ts`、`execution/`及对应测试。实施前以实际符号重核，不按本列表机械改所有文件。

## 进展与交接

- 当前角色：实施与独立验收完成；拥有者2026-10-21通过“现在由你来接手工单”授权本切片实施。
- 下一角色：拥有者接收工作区成果；没有提交、合并或部署动作，其他切片沿各自工单。
- 当前内容：实现、两平台原生边界、真实模型快照和独立审查见[实施验收](../evidence/coding-file-search-acceptance.md)；原方案审查见[记录](../evidence/plan-review.md)。
- 阻塞：无；本次授权仅覆盖本工单，不扩展其他切片。

## 验收与证据

新增`test/file-search.test.ts`从实际worker覆盖字面/大小写/glob、无glob时根内ignore/隐藏过滤、显式glob覆盖ignore/隐藏及不扩授权、全局配置排除、空结果、超长行、换行文件名、超时/输出预算、取消、rg缺失和退出2；Linux另覆盖真实非法UTF-8路径。

扩展`test/07-real-tools.test.ts`、`test/62-tool-availability.test.ts`及实际受影响的`test/101-native-execution.test.ts`：越界根、目录替换、链接与保护来源负例，Plan/只读SubAgent允许搜索但不扩大范围。两个平台跑真实原生探针，Linux用ssh tx；缺环境记未验。

实施检查：`npm run check:static`、新增窄测及上述有实际影响的测试；改worker构建再跑`npm run build:worker`和制品用例。真实模型快照验收列文件→搜索→读命中并记录schema估算；不默认跑全量check。

工程验收：通过，check:static、定向回归、两平台原生和独立实现审查均通过。产品验收：工具接口层通过，真实模型完成列文件→搜索→读取，路径/行号/过滤正确，截断及产物继读有实际worker回归；估算与原始证据见[实施验收](../evidence/coding-file-search-acceptance.md)。未跑全仓check或其他切片，不声称CI全矩阵通过。

## Comments

2026-10-21：拥有者要求制定方案；本工单不授予提交、部署或运行代码实施权限。

2026-10-21：拥有者明确要求接手本工单，进入已审方案的Coding文件检索实施；原“仅方案”限制对本切片由本次指令取代，未授予提交、合并或部署权限。
