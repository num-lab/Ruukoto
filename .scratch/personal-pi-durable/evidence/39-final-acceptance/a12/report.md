# 工单 39：A12 隔离演练

结论：2026-10-18 在 oracle-4c24g 的第二轮完整隔离演练通过，第一轮脚本验据失败单独保留。未修改生产源码或接管正式渠道。生产切换仍归 40。

实际环境为 Linux 6.17.0-1020-oracle / aarch64，Node 24.15.0、npm 11.12.1。开始时同时有候选定向测试运行；首轮前负载约 1.25/0.66/0.31（4 核），事后约 0.26/0.50/0.35。真实证据为 Linux user service、Restart=on-failure、独立 user scope、PID/starttime/InvocationID/cgroup 与停止；本机 Telegram Bot API、模型和 scope 心跳执行负载是替身/探针，不冒称真实 IM、模型或原生 worker 全链路。

当前源码为父 Agent 导出的 b1e97543 候选，旧源码为 12b1a66c 完整源导出。两个目录分别安装依赖、构建，不共用 node_modules。setup 所需本地 Git 为 source snapshot，不能当原仓库历史：current snapshot a41e531efc4018f0bfccba9078c92c7f7eeb5c83，old snapshot cde1f36a6cf093bf9b896949fad5720b01fed312。锁摘要分别为 446035b166165717ce1b020e863152967296abeb0257f679427223e928ac159c、b64f22573ce200c99c2022a1c0cd7802b9a18490915eaef4e46831d4012ab209；worker 摘要均为 ec4d123259d2ee502107d66c7598a5d88ad4a7551bf4ca9d3383cd3d70bdb909。父 Agent 已说明 current 两份原生探针 results 被先前检查覆盖，本演练不声称整个导出树从未变化。

## 实际完成

- 旧实际 main.ts/server 入口从自己的全新档案启动，完成一条主聊天。SIGKILL 后 NRestarts 从 0 变 1，MainPID 和 InvocationID 换代，原 PID/starttime 退出，后台在原档案恢复可查询。
- 旧 service disable、stop、runtime mask 后观察超过 RestartSec，MainPID=0、原 cgroup 空；再次 start 被系统拒绝。独立 scope 在 service 停止后继续写心跳，证明 KillMode=control-group 不能替代独立 scope 核实；单独 stop 后 cgroup 空、原执行身份退出、心跳不再增长。
- 停止后在旧测试库登记 registered 入站、pending 通知、到期 active 计划和 effect_unknown 工具/任务各一份。checkpoint、关闭，原地只读冻结，保存内容/权限清单、受保护一致备份及旧代码/锁备份；整个流程不重新启动原归档。
- 当前实际配对向导针对本机 Bot API 执行平台 ack：旧积压与配对消息在边界 3 及之前被确认，后台仅新消息产生 1 次模型请求、1 次发送。旧四类积压无模型执行或外发，旧归档清单不变。
- 当前实例停用且核实后，其 durable 档案也冻结。用旧实际代码与第三个全新空白档案回退，重新配置测试凭据和绑定、登记新的平台接管边界；窗口未受理消息不执行，只有新的委托产生 1 次模型请求、1 次发送。
- 回退档案没有旧计划、未知操作或待发通知；旧归档四类积压仍各一条原样保留。旧与 durable 两份归档的内容和权限清单均完全不变。
- 清理后四个精确单元均 not-found/inactive，无 MainPID；两个自建 root 在 /proc 的 argv、environment、cwd 中无存活进程，config/runtime 中无剩余精确单元链接。旧、新测试档案、备份与证据继续保留。

## 第一轮失败与第二轮修正

第一轮 /tmp/ruukoto39-a12-CG5kYE 已走完重启、独立 scope、当前接管及空白回退，最终直接用 SQLite readOnly 连接打开已 chmod 0400/0500 的 WAL 原归档查询时，SQLite 因创建 sidecar 需求报 attempt to write a readonly database。没有将此误报为产品代码缺陷。独立 Python 对照清单核实原旧归档 8 文件和 durable 归档 9 文件均未改变。另 systemctl disable 已删除 linked 单元软链，脚本 finally 再 unlink 报 ENOENT；精确单元实际已清理。首轮进程内模型完整请求未在失败前输出，只有已落盘阶段计数与操作日志；不补造首轮丢失材料。

第二轮只修演练脚本：检查已 checkpoint 主库的字节副本并先对 SHA，不再让 SQLite 打开原归档；清理允许 disable 已移除的精确软链；失败也保存平台/模型记录。全新 root /tmp/ruukoto39-a12-jmrekb 完整重演退出 0，summary.json 在全部清理成功后才写 passed。两轮原始记录、脚本和归档分别保留。

## 最窄本地复核

命令 `npx tsx --test --test-name-pattern='正式 bin 默认新档案|向导从真实配对消息|QQ：配对从真实好友消息|一次性短期确认' test/personal-entry.test.ts test/personal-telegram.test.ts test/personal-qq.test.ts` 为 4/4、0 跳过、约 7 秒，覆盖实际 bin 拒旧档案且原字节保持、QQ 平台时间及配对消息 ID 的旧重投反例、TG 向导 ack 与一周空闲后的较小 update_id。该部分为 macOS 离线测试，与真实 Linux OS 演练分开记录。

未发现需要修生产代码的已证缺陷。没有新增迁移或回滚框架，没有重跑无关全仓测试。A12 真实渠道与生产停机接管仍须沿 31/40 的实际授权及证据处理；本结果只证明本次隔离演练范围。

本地完整证据包为 /tmp/ruukoto39-a12-evidence.tar.gz，展开件在 /tmp/ruukoto39-a12-evidence/（逐文件传输若未齐，以完整 tar 为准）。远端同名包及两轮原始 root 均保留。复用脚本为 /tmp/ruukoto39-a12-rehearsal.{sh,mjs}，方案为 /tmp/ruukoto39-a12-plan.md，独立指纹与清理探针分别为 verify-frozen.py/postcheck.py。
