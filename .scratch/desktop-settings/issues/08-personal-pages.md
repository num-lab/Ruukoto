# 08 Personal 模型、Skills 与 MCP 管理页面

Status: ready-for-agent

## 目标与边界

在同一设置浮窗交付[范围矩阵](../spec.md#功能与范围矩阵)的 Personal 三页，沿 R1–R9 显示实际差异。前置：[02](02-code-models.md)、[03](03-code-mcp.md)、[05](05-code-skills.md)、[07](07-personal-connection.md)。不复制 Code 的提供方目录、摘要模型、工作区或本地路径语义。

## 方案

1. 复用三页布局与已有 UI 原语，按 Personal 实际字段展示模型配置、外部/托管技能与 MCP 服务；错误和只读状态来自 06/07。只提取已确有两个调用方的展示片段，不先做配置 provider 抽象。
2. 模型编辑 API 类型、地址、modelId、上下文/输出上限、图片能力、环境变量引用，校验定位字段；凭据状态以原服务环境核实。显式测试与保存分开，保存展示是否需停机及生效结果。
3. Skills 配置远端外部库，显示来源和诊断；导入通过远端目录选择与预览，不触发 Mac 选择器；托管技能启停/逻辑移除仍遵守 Personal 停机与未决检查，明确保留包字节供历史引用读取，外部维护项保持只读。
4. MCP 提供服务增改删、启停、显式匿名/私有凭据文件、工具发现与允许列表；不以远端标注免审批。所有代次、修订、ID、凭据摘要由程序处理。
5. 各项写入先展示影响并引导停存启；忙时展示需处理的工作及返回，不自动取消。明确已保存未启动与待核实，给出从设置继续恢复的动作；重开/重连重新读原档案，不用本地缓存冒充配置。
6. 同步 `docs/modules/desktop.md`、`personal-durable.md` 和 `docs/usage.md`；个人聊天仍未接入的事实必须保留，设置连通不等于聊天可用。

## 进展与交接

- 2026-10-21 拥有者明确表示「方案已通过」，本单范围与产品取舍已确认；ready-for-agent 表示方案可交实施，实际开工仍须满足本单前置。

- 当前为方案，未实施；基点见总规格。下一角色为实施者，先核实 02、03、05、07 已交付，完成后交 09 组合验收。
- 前置未完成；工程与产品均待验收；独立方案审查通过，见[记录](../review.md)，实现未审。

## 验收与证据

- 扩展 `test/desktop-personal-settings.test.ts` 或新增 `test/desktop-personal-settings-pages.test.ts`：三页真实字段、无伪 Code 选项、远端选择、忙与离线、停存启各阶段展示、跨目标草稿/秘密/响应隔离、重开读回。
- `npx tsx --test test/desktop-settings.test.ts test/desktop-personal-settings.test.ts test/desktop-settings-models.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-skills.test.ts`，若新增页面用例一并运行；`npm run check:static`。
- 产品验收：双壳连接真实 Linux 隔离档案，各走一次模型保存生效、技能导入/停用、MCP 配置/发现/启停；检查忙拒绝、启动失败和切回 Code 不串写。真实模型/MCP 凭据缺失的项目记未验证。

## Comments

2026-10-21：两端使用相同导航，但保留各自真实配置能力与运行约束。

2026-10-21 方案批准：依据拥有者「方案已通过」解除产品评阅阻塞，状态改为 ready-for-agent；保留前置依赖和待实现/待验收状态，未开始产品实施。
