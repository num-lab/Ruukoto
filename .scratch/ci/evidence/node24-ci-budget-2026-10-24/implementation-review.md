# Node24与CI预算：独立实现审查

结论：相对947bba81的当前实现无阻断。CI的Node22轴已删除，仅macOS/Linux固定24.15.0，job90分钟；版本门槛、包声明、锁元数据、构建目标和当前文档一致。历史Node22/四格结果保留为原记录，新双平台远端结果仍待实际运行，不以预算增加声称提速或保证成功。

## 源码与依赖核对

已逐项读取实际diff、06工单、implemented决定及关联旧工单/决定互链。CI保留原两个OS、fail-fast=false、系统前提、setup/check和离线设置；scripts/test-app与单测试/产品期限没有变化。两个旧node22.19 bundle target均改node24.15；根worker原node24 target不需要变化。

setup/check共同门禁、桌面登录/managed共享parseProbe和部署示例均采用同一>=24.15比较。Desktop旧版本及invalid继续返回node_unavailable；登录/managed入口仍分别沿原环境采用路径，认证、PATH来源和取消预算未变。测试确实通过可执行fake node/shell输出probe正文进入parseProbe，没有以返回DesktopEnvironment绕过版本判定。

独立JSON核对12份本仓manifest均为engines.node >=24.15；去掉engines后和基点完全相同。根lock仅root、七packages、三个apps这11个精确条目改变engines，foundation lock仅root新增engines。第三方节点（包括apps/ruukoto/node_modules下的嵌套依赖）、版本、resolved、integrity及所有其他字段均未变化。`.node-version`本已24.15.0。具体断言结果及源码指纹见metadata-check.json。

Store.chatResultOpCommitted和SchedulerStore.hostOpCommitted只去掉Node22注释并改为位置get参数，SQL文本、schema、结果判断与事务边界未变。相关query-child仍说明同步数据库不能用同进程Promise.race取消，仅删除过期版本限定。

## 本人执行的最窄验证

在macOS/Node24.15执行，未跑全量/native，也未启动真实模型、OS worker或部署动作。

1. `node --import tsx --test '--test-name-pattern=setup 环境检查|仓库缺失与 node 不可用' test/98-development-tools.test.ts test/38-desktop-main.test.ts`：2/2，零跳过/失败/取消，exit0；Node汇总2.094秒。setup核实22.19、22.99、24.14拒绝，24.15/24.16/25通过；桌面登录与managed均核实22.x、24.14及invalid拒绝，24.15/25通过，保留关闭期间不新建连接断言。原日志version-tests.log。
2. `/tmp/ruukoto-node24-implementation-review/store-probe.mts`直接导入当前实际Db、Store与SchedulerStore，在独立临时真实SQLite使用原写接口准备事实，再调用改动后的两个查询，11项全部通过、exit0。Scheduler分别覆盖create_op_id、cancel_op_id、notification host_op_id、notification cancel_op_id及不存在；chat分别覆盖首次accepted_by_op_id、重复接收通过JOIN找到旧快照、其他工具拒绝、未接收目标拒绝及不存在；两个读取不追加事件。原脚本和输出store-probe.log保留，finally关闭DB并只移除自有临时目录。

上述真实Store probe补足现有宽回归未逐列直接命名的分支；它不是只重复SELECT语法，也不替代实施者正在执行的37/49/64账本恢复及构建检查。本审查未重新跑其全部重准备。

## 当前文档与范围

README、AGENTS、开发/使用、Desktop、产品、部署说明、foundation与pre-push当前要求已同步。usage浏览器段只删除旧Node22支持理由，仍采用原官方native资产，没有顺便改变安装方式。02及03/04/05当前环境验收转由06持有Node24双平台/90分钟；旧基线、失败日志、Node22受控证据未被改成新环境通过。当前旧笔记通过部分取代链接保留决策历史。

一项非阻断措辞建议已发实施者：packages/core/src/db.ts开头仍写“node:sqlite，Node ≥22.5”，实际是API引入版本而非当前支持下限；删除这段版本限定即可避免误读，无需任何数据库逻辑改动。若已按建议清理，应由后续静态/文档结果记录；不要求重跑行为检查。

静态、根build、脚本/desktop定向与MyGo实际构建由实施者持有；本报告没有代为记作完成。最终新CI两个OS都实际进入foundation并正常退出才算远端验收。所有本审查产物仅写/tmp，主仓只读。
