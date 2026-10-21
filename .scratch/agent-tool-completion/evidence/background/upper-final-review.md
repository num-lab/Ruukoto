# 会话后台：最终上层独立审查

结论：截至旁附内容快照，未发现未解决阻断。只读核对共享规格第3节、core占用与关闭屏障、Runtime接线、control/view以及两端客户端；此次未修改主工作区，也未执行正在由scope_audit独占的macOS监督器测试。本人参与过客户端实现，本记录对core/Runtime是独立实现审查，对客户端是最终复核，不能替代另一上下文对客户端的独立审查。

## 最终复核

状态、目录占用转交和conversation事件在同一事务；Task终态、恢复及resume_queue不释放独立占用。启动认领至多一次，关闭屏障拦截旧已接纳Task，原关闭键固定目标集合；日志/停止证据不与SQLite或JSONL宣称原子。发送前与调用门保留来源及观测阶段限制，重新写入须核实停止后取得目录。

状态页同时限制20条和完整result JSON的256KiB，nextOffset按实际条数推进。首次精确临界探针发现仅计记录漏算wrapper（262187B）；修复后同一探针返回2条、197457B、nextOffset=2，余1条可读。临时脚本与前后输出为`/tmp/rk-page-budget-proof.ts`、`/tmp/rk-page-budget-probe.log`及`/tmp/rk-page-budget-fixed.log`。新source来自持久record.source，仅保留coding-owner及full_access；modelProcess保留该事实，不暴露原输入、路径或任务内部引用。

关闭请求发送前保存原键。PendingRequestStore.list(true)在目录读取失败时上抛，Guard转pending_record_unavailable且零新发送；损坏单条、未知结果以及旧请求重核not_sent均保留原键。重连/刷新只查状态，显式确认才原键核实。TUI和Desktop列表使用真实页offset栈；独立探针两端均完成0→2→4→2→0，未固定减20（`/tmp/rk-background-offset-proof.mts`）。日志保持原字节offset与base64，退出观察和停止核实分开。关闭面板、会话标签、断开与存档没有后台停止调用。

亲验当前`node node_modules/tsx/dist/cli.mjs --test test/background-processes-core.test.ts test/background-process-clients.test.ts`为29/29，无失败或跳过；另两条临界分页/双端offset临时探针均通过。之前亲验core与control seam35/35、跨轮HTTP2/2、恢复5/5。关闭屏障行为反证：现源码拒绝关闭前接纳Task迟到登记；仅内存删除水位核实后预期失败，生产源码SHA前后相同。

## 真实Linux证据与内容关联

| 证据 | 实际执行及范围 |
| --- | --- |
| `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-background-linux-proof-8mk19y3t` | ssh tx / Ubuntu kernel6.8 / systemd255 / Node24.21；原始生产模块bundle。普通setsid后代、继承管道、主进程退出、宿主和主进程SIGKILL后独立停止，原引用重复启动拒绝；InvocationID/指纹/inode错误及真实同名scope换代拒绝误杀。27/27窄测；cleanup中27个本次PID均不活、原及后代cgroup均消失。run.log/checks.log/cleanup.json、source/、rebuild.mjs与source-manifest.json均保留。主动新建scope脱离属于既有完全访问例外，单列且清理本次进程。 |
| `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-bg-integration-evidence-fh73x1j5` | 远端`/tmp/ruukoto-bg-integration.MvKmmxw0`执行`node node_modules/tsx/dist/cli.mjs --test test/background-processes.test.ts test/background-processes-recovery.test.ts test/background-processes-core.test.ts`，19/19，无跳过。包含真实HTTP跨轮、宿主SIGKILL冷恢复零重放、16MiB预算、短写EIO注入及关闭竞争。580文件与worker哈希匹配，verification.json中remainingFixtures及activeProbeScopes均为空。初次缺quickjs失败记录保留；复用已安装依赖并复制现有纯JS/WASM，无下载。 |

Linux集成内容由source-final.tar.gz与source-final-manifest.json固定。亲比当前版本：Runtime接线、Driver及Linux启动与身份两文件与该快照逐字相同；Runtime后台管理与agent后台入口仅更新笔记锚点；core新增公开来源与分页预算，已按上述当前上层窄测和临界探针复核。Linux快照不冒充最终macOS监督器版本。

当前审查内容的34文件SHA/大小见`/tmp/rk-background-final-upper-snapshot.json`；后续实质修改仅使受影响部分失效。模型验收JSON已读取，显示deepseek-flash启动→browser→跨轮日志→停止→write链通过，但由作者实际执行，本记录不计作本人亲验。

## 真实客户端补验

在`/tmp/ruukoto-bg-real-clients-20261021`补了真实Runtime、ControlServer、实际`process_start`工具和macOS后台执行的TUI/Electron链，模型使用mock HTTP端点。`final-tui/`三轮Python PTY完成后台清单、stdout/stderr随机token、单停、退出保留、确认结束；实际HTTP、stopVerified、占用与closure分别断言。真实PTY发现并保留了offline提示残留和实时刷新吞动作结果反例；主代理修复后重跑精确断言，offline不再残留，单停不再显示“正在登记停止”，结束出现“本次结束请求涉及的后台已核实停止。”。三次TUI正常退出并恢复终端，最终探针收到EOF退出0。

`electron4/`复制最终out到独立目录，仅在复制件加show:false，用真实Electron/preload/IPC/ControlClient及CDP鼠标操作实际控件；没有fake bridge。读双流随机token、单停、退出整个Electron后HTTP与占用仍保持、新Electron重连后确认结束均通过；三次Electron退出码均为0。已查看stdout与结束后PNG，日志和操作状态可读。前几次脚本环境/鼠标目标错误与完整清理证据仍保留，README区分原因；最终`cleanup-verification.json`核实所有尝试12个fixture PID均已消失、全部HTTP URL断开。原始PTY/DOM/PNG、控制调用、隔离档案和实际源码/产物SHA均保留。

验收完成后两端只将确认说明改为“停止并核实本次结束请求涉及的后台；保留会话和历史。”，不改按钮和行为；当前记录与SHA固定文案简化前的实际检验内容，不宣称执行过后续重建。

## 未覆盖

本轮没有亲自重跑真实模型或真实browser工具；先前浏览器交互使用假control数据，只证明菜单/列表/日志分页/确认/关闭无停止副作用及1280×800布局，不能代替上述真实Electron链。本轮不评价最终macOS监督器的身份与停止专项实现，由scope_audit记录其独立证据。未验证断电耐久性、个人durable接入或主动脱离执行单元后的回收；这些不是当前切片的既定保证。未提交、推送或部署。
