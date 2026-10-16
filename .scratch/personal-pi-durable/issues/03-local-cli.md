# 隔离个人实例的引导 CLI 与本机管理

Status: ready-for-human

## 目标与边界

接续[总工单](01-migration-plan.md)阶段 1 与[基础工单](02-harness-foundation.md)，落实[规格](../spec.md#产品范围)中后台独占 Harness、客户端断开不取消输入、离线配置必须持实例锁的要求。拥有者已确认的 Q6/Q18/Q19 及本轮接手指令继续有效，无新增产品取舍。

提供独立隔离命令 `npm run personal:durable`，默认按检出真实路径分配 `~/.ruukoto-durable-dev/` 下的档案，显式 `RUUKOTO_PERSONAL_DIR` 可选择另一个新档案。逐步选择配置模型、启动后台、状态、发消息、最近记录与停止；不要求输入内部 ID 或请求键。后台只装配当前空工具集，不接入真实 IM、业务工具和旧 Runtime；正式 bin、start/dev 与部署仍待完整能力验收后接线。

## 方案

1. 在个人 app 增加配置读写、管理服务/客户端与引导入口。复用 `parsePersonalModel`、`openPersonalHarness` 和现有锁；模型凭据仅保存环境变量名，不复制旧配置或凭据。配置用同目录临时文件加 rename，只有持锁者可写，崩溃留下的临时文件可在下次持锁配置时覆盖。
2. 本机 HTTP 仅监听独立 Unix socket，目录 0700、socket/token 0600，令牌逐启动生成并在每次请求校验；先取得实例锁再清理陈旧 socket，不使用 PID 猜测或信号接管。增加已知配置、临时文件、令牌、socket、逐键客户端待核实文件与诊断日志的档案检查，继续拒绝链接和旧目录。服务在持锁后读取配置；Harness 接受已持有的具名档案锁，接管它的释放责任。正常关闭和存储故障均先执行一次 `beforeUnlock` 关闭 listener、收齐在途 handler，再放实例锁；`close()` 等待该清理。停止请求先完成应答和自身 handler，再启动关闭，避免等待自身。
3. 服务仅提供状态、受限最近消息、提交、按原键核实提交与停止。输入长度、请求体、超时、响应大小均有界；提交先持久化每键一个 durable doc family 的正文指纹，再交原生 admission 并等待持久化后应答。指纹不保存执行状态；同键异参明确拒绝，指纹提交后而 admission 前崩溃可由拥有者选择原键重送。客户端提交前以 `wx` 创建 `pending-<UUID>.json` 保存原键与正文，各 CLI 不覆盖彼此，配置/启动不清理它；只在核实对应 submission 后删该文件。失去应答时下次连接先核实原键，不自动换键或重发；断线不 abort。
4. 向导用 Node readline 逐步选择，不依赖绑定旧协议的 ConfigTui。启动为独立后台进程，退出向导不停止实例；停止经过认证接口。机器子命令 `serve` 只供前台托管与进程测试。开发入口不引入热重载或旧客户端事件投影。
5. 更新个人模块、产品/架构的适用范围和 README、development、usage、pre-push-checks 的隔离命令；新增笔记记本机管理契约，不改迁移总方案的 proposed 状态。真实模型以显式门禁的 `verification/smoke/smoke-personal-durable.mts` 验收，两次输入间重启独立后台，核对上下文延续与请求证据；凭据仅经进程环境。

## 进展与交接

- 当前角色：实施者；本窄范围工程验收通过、独立实现审查无阻断，等待拥有者实际操作向导确认体验。真实 PTY 自动驱动不是拥有者产品验收。
- 实施基点：`6105c5af4c07d94f4b6aa7bf9f6fed91512b3339`，分支 `Eitrous/migrate-to-pi-durable`；本轮实现与材料由本工单同批提交承载。实现、测试、笔记和文档的[内容快照](../evidence/03-local-cli.sha256) SHA-256 为 `690dd2c23dbf59090d704dcf6ddac835bfed15c7c5e44fa2e505c98351ee41ab`；工单正文不参与自指快照。
- 单写入者为主上下文；独立上下文只读调查/审查，Linux 验证使用独立副本。所有本轮本地及远端测试实例、socket 和临时档案已清理，既有服务未接管。
- 拥有者补充真实模型前提：本地指定 `/Users/eitrous/.ruukoto-code-dev/ruukoto-2159f2e3/agent/models.json` 的 `workbuddy-ai/deepseek-v4.1-flash`（实际 provider 为 `magpie`）；远端指定本地 `/Users/eitrous/.ruukoto/agent/models.json` 的 `deepseek/deepseek-flash`。只读取选定配置，不复制凭据到新档案；远端经 SSH stdin 在内存传递。
- 下一角色：拥有者体验隔离向导；实施者接续总工单阶段 2 的权限/外部执行扩展，随后完善业务配置和正式入口。没有新增产品取舍阻塞；Node 22 本机无二进制，完整 IM/权限/业务验收仍由总工单持有。

## 验收与证据

| 对象 | 证据与结论 |
| --- | --- |
| macOS 离线 | 作者在 Node 24.15.0 运行 `npx tsx --test test/personal-cli.test.ts test/personal-durable.test.ts`，最终 40/40。真实 SQLite、HTTP/socket、独立后台与客户端进程；模型为本地替身。覆盖配置锁、权限/链接拒绝、认证前零模型请求、异参拒绝（含孤立 UTF-16 代理）、指纹先提交、应答丢失、并行客户端记录、重复启动、故障清理与重开历史。 |
| Linux 离线 | 独立上下文经 `ssh tx` 在 `/dev/shm` 隔离副本安装原锁依赖，Node 24.21.0/npm 11.19.0，`npm ci --ignore-scripts --omit=dev --no-audit --no-fund` 后，以独立 npm 配置/cache/TMPDIR 和 `RUN_MODEL_CHECK=0` 跑相同两文件：40/40、零跳过、约 5.08 秒。[受测快照](../evidence/03-linux-offline.sha256)包含 JSON 指纹修复；后续仅增加解释注释与恢复更严格的历史数组断言，macOS 已补验。两次 `/tmp` 安装先因 ENOSPC 失败，未记通过；tmpfs 安装成功，结束核实本轮进程/socket 为零并清理。 |
| 引导流程 | 作者用 Python pty 真实启动 `personal-entry.ts`，依次完成接口选择、地址/模型/凭据变量填写、默认预算与退出，核对 `model.json`；未启动模型或 IM。首次驱动只等进程而未持续读取 PTY 超时，修正驱动持续读取后通过；未据此修改产品代码或声称人工体验通过。 |
| 真实模型 | 作者本地运行门禁 smoke，以 `magpie/workbuddy-ai/deepseek-v4.1-flash` 完成两次输入、独立后台重启、历史延续与四条证据；随后仅加强 smoke 失败清理顺序。独立上下文在 Linux 按最终脚本 `03619601cf3c7c30467a3b0143c011d4e726fac1cd9eb16187b0c473a05f07c4` 使用 `deepseek/deepseek-flash` 完成相同验收，退出 0；受测运行时代码与当前快照一致。两处均断言认证值未进入证据，无 IM/外部工具。远端独立安装 334 包、原锁不变、凭据只经 stdin/环境、测试进程/socket/档案为零后清理副本。 |
| 既有回归 | 作者运行 `npx tsx --test test/71-product-entry.test.ts test/122-workflow-code-acceptance.test.ts`：18/18。含真实 bin 两产品并存/停止与 Coding 五份冻结成果流程，约 102 秒；不将旧个人行为记作新个人能力。 |
| 构建与静态 | `npm run build`、`npm run check:static` 通过；最终 smoke 新增后再跑静态通过。新笔记与人类文档同步，README 保持预算，无依赖或锁文件变更。 |
| 独立方案审查 | 2026-10-17，`entry_audit` 对照规格、源码及上游 admission 公开 API；补齐指纹、逐键客户端文件与 listener 放锁顺序后通过，无新增拥有者决定。 |
| 独立实现审查 | 2026-10-17，`local_review` 亲跑两文件最终 40/40，另补受影响指纹 2/2；发现前台绕过保留凭据名校验后，统一到配置解析并复审通过。隔离副本撤掉凭据校验，新回归失败；撤掉 JSON 字符串编码，孤立代理异参断言失败。最终无阻断。新增 smoke 单独复审，亲跑三组缺前提门禁均退出 2，未读真实凭据或重复模型调用。 |

工程验收通过仅限上述窄范围。产品验收待拥有者真实操作向导确认；A1/A8/A9/A11 仅增加子项证据，完整阶段 1 与 A1–A12 不据此完成。Node 22 未执行（本机未安装）；没有跑全量 `npm run check`，没有真实 IM、Linux 外部工具或切换演练，均不以本轮空工具会话替代。

## Comments

2026-10-17：接手总工单后核对 HEAD 与有效规格，划定本轮实际接口，进入独立方案审查。

2026-10-17：完成本机引导管理，独立审查修正前台凭据校验并补正文编码边界；macOS/Linux 离线、两组拥有者指定真实模型及正常重启验收通过，保留人工体验和后续完整迁移验收。
