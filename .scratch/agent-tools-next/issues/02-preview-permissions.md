# 网页预览不再要求完全访问

Status: resolved

## 目标与边界

2026-10-25 拥有者明确要求去掉网页预览权限限制。`present({url})` 在 confirm、auto-review、full_access 和 Plan 均直接登记预览，不检查浏览器自动化资格、不生成操作审批。保留任务活动与工具集合校验、无凭据 HTTP(S) 校验、桌面 iframe 隔离；文件预览的读取权限和 browser 自动化规则不变。

## 方案

删除 ToolRouter 的 presentUrlAllowed 回调及 Driver 注入，删除 present URL 分支的资格检查与审批请求，同步模型描述。URL 分支保留原审批所核实的任务存在、同会话、running、未取消及 signal 未中止条件，不再按访问模式或权限版本拒绝展示。修改现有真实 Runtime 测试，在四种模式核实成功工具结果、持久预览事件、零审批及实际模型描述；保留危险地址和文件范围回归，补取消／中止拒绝。同步 agent-tools、desktop 的现行说明，新增决定笔记部分取代原 present 完全访问约束，原工单链接此后续决定。完成后跑定向回归与 check:static，再由另一上下文审查实现。

## 进展与交接

基点63077580，开始时工作区干净。preview_landscape 独立方案审查指出审批还持有任务活动检查，已纳入上述保留条件；实施与独立实现审查完成，无剩余阻断。旧实现运行新验收用例在 confirm 明确失败，见[修改前日志](../evidence/preview-permissions/before.log)。当前改动随本工单入库，源码指纹见[快照](../evidence/preview-permissions/source-snapshot.json)。

## 验收与证据

工程验收通过。`test/present-tools.test.ts` 3项通过：四种模式成功且零审批、持久工具结果、实际prompt描述；未运行／缺失／异会话／取消／signal中止拒绝，URL校验及文件范围保留，见[修改后日志](../evidence/preview-permissions/after.log)。桌面检查器、工具活动、62工具资格与browser-tools合计108项通过，见[回归日志](../evidence/preview-permissions/regression.log)。`npm run check:static`通过，见[静态日志](../evidence/preview-permissions/static.log)。

实际请求估算：toolSchemas 14291 → 14292，systemPrompt 1500 → 1500。preview_landscape 独立读取实现、文档并亲跑present-tools 3/3，确认browser自动化、文件读取及iframe未放宽，审查通过。

产品验收不适用：本次只取消拥有者明确要求移除的模式门槛，没有新增布局或主观体验取舍；页面渲染与侧栏沿原实现。真实窗口与真实模型未执行，不记通过；原工单的体验缺口继续保留。不重复无关构建或全仓检查，拥有者已授权提交；未推送或部署。

## Comments

2026-10-25：拥有者授权提交；提交前独立核对7个源码、测试和文档哈希全部匹配，无任务范围外改动，原验收证据继续适用。
