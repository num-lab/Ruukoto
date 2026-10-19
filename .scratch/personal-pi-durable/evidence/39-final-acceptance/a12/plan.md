# A12 最小隔离演练

审查对象为规格 A12 与工单 39；不操作正式单元、渠道或档案。本方案只使用新造测试数据、专用本机 Bot API/模型替身、当前源码与 b1e97543^ 的旧源码。实际 systemd user service、自动重启及独立 scope 属真实 Linux 证据；平台与模型仍为替身，必须如此标注。

## 输入与保护

- `CURRENT_REPO`：最终候选的独立完整检出/依赖/worker，`OLD_REPO`：b1e97543^ 的独立完整源码/依赖/worker，`NODE_BIN`：当前规定 Node 版本。两者不能共用数据档案。
- 只创建 `/tmp/ruukoto39-a12-*` 根目录和 `ruukoto39-*` user 单元；单元名带随机 nonce，所有操作按精确名称执行。子进程以 env -i 加明确测试配置启动，不继承生产渠道、服务或数据目录变量。
- 停止与清理只作用于脚本登记的准确单元；不能扫描停止其他 `ruukoto*`，不能停止 user manager。原始测试档案、冻结清单和日志保留供核对。

## 顺序与断言

1. 起真实旧入口 `OLD_REPO/apps/ruukoto/src/main.ts server --data-dir ... --agent-dir ... --model mock/mock-model --tools mock`，以绑定自己的模型/Bot API 替身完成一条旧主聊天，证明不是死服务占位。
2. 配置 `Restart=on-failure`，记录 MainPID、/proc starttime、InvocationID、cgroup，SIGKILL 旧 MainPID，核实 NRestarts 增加、PID/InvocationID 改变、旧身份退出、同档案后台重新可查询。并行创建一个真实独立 scope 与心跳进程；明确它是隔离 OS 探针，不冒称完整原生 worker 验收。
3. `stop` 并 `disable` 旧单元，`mask --runtime` 阻止再次启动；观察超过 RestartSec，核实服务 inactive/failed、原 service cgroup 空。此时独立 scope 仍在写心跳，证明后台退出本身不等于执行全停；再准确停止 scope，核对 scope cgroup 空、心跳停止和原 PID/starttime 退出。任何不可核实都中止接管。
4. 后台停止后，通过旧 Store/SchedulerStore 在专用旧库生成 registered 入站、pending 通知、active 且已到期计划、effect_unknown 工具/任务记录，保留这些行的原始查询。checkpoint 并关闭库，旧档案原地 chmod 为只读，生成 SHA-256 内容清单及受保护 tar 备份；此后不再打开旧库写连接。
5. 向替身 Bot API 放旧积压，调用当前实际配对向导；根据 getUpdates 的真实替身服务端 ack 语义记录边界，确认积压和配对消息被 ack。以当前实际 bin 启动另一个空白 durable 档案，新输入执行一次，旧标记零模型调用/零发送、旧档案指纹不变。QQ 平台时间与稳定消息 ID 的旧重投反例使用当前最窄离线测试，并与 Linux OS 演练分开记。
6. 停当前实例，核实 cgroup 与 PID 退出后冻结 durable 档案并保存指纹。使用旧代码及第三个全新空白档案回退，不加载两份归档；独立重新配置测试凭据与绑定，手动登记新的平台 ack 边界，再启用旧入口。新消息执行一次，原旧库 registered/pending/active/unknown 均无执行或发送，durable 旧记录也不执行；两份归档指纹完全一致。
7. 停回退实例、清理自己创建的单元软链和 runtime mask，保留全部测试档案、清单、日志、PID/cgroup 时间线与结果。仅用旧库只读查询确认四类积压仍在，禁止为了观察而启动归档。

## 当前实现与复用证据

- `apps/ruukoto/src/personal-profile.ts:19` 先验证目录内容，旧 ruukoto.db 档案被拒；`test/personal-entry.test.ts` 有实际 bin 旧档案原字节保持反例。
- TG 接管边界由 `personal-cli.ts:165–182` 在配置持锁期间完成服务端确认；运行时故意不永久用旧 update_id 过滤，以兼容一周空闲后的 update_id 随机起点。不能把 `boundary` 字段本身误当运行时过滤。`test/personal-telegram.test.ts` 的向导和较小 update_id 测试可复用。
- QQ 在 `personal-telegram.ts:180` 用平台时间与配对消息 ID 排除同秒/之前及配对重投；`test/personal-qq.test.ts` 的配对测试含宿主时钟差与配对消息改时重投反例。
- `deploy/systemd/ruukoto-backend.service` 为 Restart=on-failure、KillMode=control-group；手册正确说明独立 user scope 另行核实。
- `evidence/20-linux/report.md` 明确 systemd/sudo 为替身、没有真实 systemd，不是 A12 证据；不能用 380 个旧用例拼成 A12 通过。

当前未发现已证明的切换生产代码缺陷；缺口是尚无上述真实 OS 与空白回退组合证据。最小解是操作演练和证据，不新增迁移/回滚框架。若演练失败，先保留原始失败与归档，按最窄反例修根因。
