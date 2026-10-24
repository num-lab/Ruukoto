# Node24与CI九十分钟预算：独立方案审查

结论：方案无阻断，可以实施。用户明确提高timeout-minutes并结束Node22兼容，已取代02原矩阵/45分钟限制；90分钟、两个OS固定Node24.15.0与最低>=24.15均落在授权范围。不需再次确认，也不应把延长预算说成性能优化或保证下一轮通过。

被审基点947bba81，开始时除新06工单/提案外无源码差异；文档指纹见plan-identities.json。本轮只读代码与计划，唯一执行为Node24.15内存SQLite小probe，未跑native、全量、构建或改主仓；CI40079786517的远端事实沿主实施者已读取的记录，本审查没有独立重取远端日志。

## 代码范围核对

- 唯一CI入口 `.github/workflows/check.yml` 当前os×node四格、job45分钟；matrix.node只用于setup-node。移除node轴、固定24.15.0、job90分钟可形成两个OS任务，保留fail-fast=false、系统前提、setup/check、独占与并发、离线开关和失败透传。
- 12份本仓manifest：根、七个packages、三个apps、独立foundation。Desktop/foundation目前没有engines，须新增；其余从>=22.19提升。根lock对应root/apps/packages的精确本仓键、foundation lock的root元数据同步即可；不能因apps/前缀误改apps/ruukoto/node_modules中的第三方engines或依赖解析。`.node-version`已经24.15.0，无需机械改写。
- `scripts/check-environment.mjs`是setup与check共同版本门禁；Desktop登录和managed两路共用`environment.ts`的parseProbe；部署示例另有内联版本谓词。三处应使用一致>=24.15规则，保留原DesktopError code，不改变环境采用、认证或执行失败分类。
- 只有workflow script与MyGo sidecar仍target node22.19；提升node24.15即可。根build:worker已target node24，对最低24.15仍有效，无需扩成另一构建改造。
- 两处兼容实现确为`Store.chatResultOpCommitted`与`SchedulerStore.hostOpCommitted`的重复?1具名对象绑定；SQL本身和schema无需变化，改get(opId)/get(hostOpId)。query-child注释的同步DatabaseSync行为仍成立，只删除过期Node22.19限定。

## 验证与文档补充

已在本机v24.15.0对含重复?1的UNION查询亲自比较位置与具名绑定：首SELECT命中、第二SELECT两个OR分支分别命中及全不命中结果完全一致。生产验证继续用37-scheduler-outbox账本恢复、49-chat-result-flow和64-tool-op-ledger；不以这个语法probe代替真实表/恢复调用。

setup及Desktop原测试适合扩展边界表：22.x、23.x、24.14拒绝，24.15及更新通过。Desktop通过真实probe格式核实两个入口的共享parseProbe；仅注入返回DesktopEnvironment会绕过新门禁，不能当版本校验。保留node_unavailable和原PATH/登录环境规则。静态、相关窄测、workflow构建、MyGo sidecar构建满足本次范围，无需先机械全量。

计划已覆盖主要常驻文档，另显式提醒两点：`docs/usage.md:663`仍以“宿主支持Node22.19/24”解释不用npm browser wrapper，应删除这一过期理由，保留原native资产安装选择；03/04/05当前下一责任仍写“原四格”，同步转由06持有新双平台/90分钟验收，历史Node22红绿和旧四格日志保持不变。pre-push的Cua双版本当前要求也应移除Node22。新implemented笔记对原CI前提/测试精简/联合验收只做部分取代互链，不改归档正文或既有实测数字。

没有发现需扩大范围的隐藏Node22开关。后续实现审查重点是锁文件仅本仓metadata、版本边界正负例、SQL四个宿主ID分支/聊天接收恢复仍正确，以及新CI双平台真实进入foundation并正常退出。没有新远端结果时继续待验收；旧取消记录不改为通过。
