# 双外壳设置最终组合验收

## 对象与结论

2026-10-22，基点 `614d97cecb693f934b80486d20723fcda533a993`，接手 HEAD `0b6775721e5c4bf61a99721f3ac21bd1bb780719`，开始时工作区干净；本轮四项源码修复、回归与文档在验证时为未提交快照，拥有者随后明确授权提交当前分支，未推送。最终源码散列与环境见[快照](09-snapshot.json)，工程验收通过，独立 Spec 与 Standards 无未解决阻断。工单保持 ready-for-human：拥有者指定真实 HTTPS MCP 尚缺端点，原生 Electron/MyGo 交互和六条完整主流程仍须产品验收。

拥有者指定 `oracle-4c24g` 和 `/Users/eitrous/.ruukoto/agent/models.json` 的 `deepseek/deepseek-flash`，选择先由 agent 完成可自动化验证，再由拥有者体验验收。Code 的真实显式模型测试通过；Personal 经真实 SSH、固定 systemd 与打包后的 MyGo Node 宿主通过模型测试/保存、技能导入/停用，以及历史档案、启动失败恢复和丢答核实。打包宿主验证不等于启动了 WKWebView 或 Electron 窗口。

## R1–R9 证据表

| 要求 | 工程与实际运行证据 | 保留的产品缺口 |
| --- | --- | --- |
| R1 作用范围与迟到隔离 | 容器、Code 三页、Personal Host/页面覆盖无会话、原来源、跨实例/目标票据；真实 MyGo Host 只写 Oracle 指定新档案，重开读取原档案 | 原生两壳的范围提示与焦点体验 |
| R2 修订与稳定身份 | Code 目录/MCP/Skills 冲突回归通过；Personal 托管冲突准确分类为明确未保存；真实历史档案旧修订与占锁拒绝，当前配置保持 | 拥有者确认冲突比较可理解 |
| R3 拒绝与丢答 | 原桌面提交/审批/恢复交叉回归通过；真实保存完成后丢弃 SSH 应答，重开仍待核实，只读比较后恢复/结束，写入一次 | 原生两壳未知结果提示与恢复操作 |
| R4 凭据与脱敏 | 31-model-config 和设置用例覆盖无动态求值、来源限定、清理与错误脱敏；真实服务环境可用、新 SSH shell 中变量不存在；临时凭据删除，档案扫描无认证值 | HTTPS MCP 的实际凭据引用与发现 |
| R5 默认与当前会话 | 模型页、38-desktop-main、desktop-session-settings 覆盖目录事件、composer、新会话继承、任务钉版；02 的 TUI 在线/离线证据沿用，相关源码未改变 | 拥有者检查原生会话菜单与新会话体验 |
| R6 MCP 与 Personal 生命周期 | 24/25 MCP 和来源后台回归保留允许列表/批准消费；真实固定服务停存启、令牌轮换、忙拒绝、锁、已保存但启动失败及显式恢复通过 | 指定 HTTPS MCP；原生两壳的 Personal MCP 全流程 |
| R7 技能与历史 | managed-skills/reference 与 personal-managed-skills 回归保留固定路径/旧引用；Oracle 真导入、停用、启动读回，源内容未写；原历史 entries 保持 | 原生目录选择器、旧引用与逻辑移除说明体验 |
| R8 状态与可访问性 | 容器与页面状态、布局/SSR、430px 既有合成浏览器证据通过；本轮恢复路径回归及真实失败恢复通过 | 原生明暗、窄窗、键盘/读屏名称、焦点、减少动态效果与未保存保护 |
| R9 两壳与真实配置 | 两壳构建/签名、Go race、包内输出/桥接核对通过；MyGo 包内 sidecar 对真实 SSH/systemd 配置完成写入与重开核实 | 原生 Electron/WKWebView、退出重开后的完整六流程；模拟 MCP 不抵扣真实端点 |

## 检查与制品

初轮组合以接手代码启动，384 项中 382 通过、1 失败、1 Linux 专用跳过，约 313 秒。失败为 `desktop-settings-mcp.test.ts:87` 把并发创建数组顺序误当工作区显示顺序；修正为显示列表首工作区，保留自身来源及映射会话原来源断言。Linux 跳过项已在 Oracle 亲跑 1/1，通过，见[服务回归](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2F09-linux-service-regression.log)。后续改变的文件以最终窄复跑为准，未改变模块沿用初轮通过项与各前置交付证据。

初轮命令：

```sh
npx tsx --test --test-concurrency=1 test/desktop-settings.test.ts test/desktop-settings-models.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts test/desktop-settings-skills.test.ts test/desktop-personal-settings.test.ts test/desktop-personal-settings-pages.test.ts test/38-desktop-main.test.ts test/38-desktop-personal.test.ts test/38-desktop-build.test.ts test/39-desktop-recovery-guide.test.ts test/desktop-session-settings.test.ts test/desktop-mygo.test.ts test/24-mcp.test.ts test/25-mcp-write.test.ts test/managed-skills-reference.test.ts test/personal-managed-skills.test.ts test/personal-settings-blockers.test.ts test/personal-cli.test.ts test/66-control-seam.test.ts
```

| 最终检查 | 结果 |
| --- | --- |
| `npx tsx --test test/desktop-personal-settings.test.ts test/desktop-personal-settings-pages.test.ts` | 44/44 |
| `npx tsx --test test/desktop-settings-mcp.test.ts test/desktop-models-layout.test.ts` | 22/22 |
| `npx tsx --test test/personal-maintenance.test.ts` | macOS 10/10；Oracle 最终同文件 10/10、无跳过，见[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2F09-linux-maintenance.log) |
| Standards 亲跑 `test/managed-skills.test.ts test/personal-settings.test.ts test/personal-maintenance.test.ts test/31-model-config.test.ts` | 当时 64/64；后续维护修复由上述最终用例与独立负例替代旧维护结论 |
| `npm run check:static` | 源码返工后通过；最终记录/文档另跑 `npm run check:docs`、`npm run verify-notes` |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 最终桌面源码构建通过；保留既有 chunk、打包元数据及未公证提示 |
| `cd apps/desktop/mygo && go test -race ./...` | 通过；Go 桥自基点有改动，最终未再变更 |
| 两壳 `codesign --verify --deep --strict` | 通过，仍是 ad-hoc 签名 |
| `npm run build --workspace=ruukoto` | 最终维护源码重包；78 个普通文件与源码一致，见[包比较](09-personal-package.json) |
| 解包正式 bin 正负入口 | 8/8：机器单行 JSON、未知操作/版本/SQL/旧修订拒绝、CLI 维护只读、显式 serve 目录及缺模型拒绝，见[入口结果](09-package-entry.json) |
| Electron asar 与 MyGo sidecar/launch/preload | 与最终输出一致，共用 8 项 Personal 管理操作与 request 桥，见[制品结果](09-artifacts.json)；个人远端程序由独立 app 包提供 |

本机完整命令日志保存在 `/tmp/ruukoto-09-acceptance.tRv1S5O1/`；解包探针为 `node /private/tmp/ruukoto09-package-entry-0fsx15zy/probe.mjs <仓库绝对路径>`。没有运行全仓 `npm run check`，没有增加依赖或生产部署。

## 独立审查与返工

Standards 上下文 `/root/acceptance_standards` 直接读取基点以来全部最终实现，再核对未提交返工；未发现硬违反或需单列的代码气味。检查权限、秘密、托管布局、错误类型、字段保留与双壳宿主，另以自有 `__proto__` 请求头负例证明基点丢字段、当前目录保留并遮蔽。

Spec 上下文 `/root/acceptance_spec` 直接核对 R1–R9、调用方与最终代码，亲跑组合疑点与每轮返工的窄回归。以下四项均已解除；隔离副本撤去修复后对应回归准确失败，未改断言放宽行为。额外拒绝负例核对缺安全字段、非空停止脚本、failed+非零 PID、启停中及档案占锁均拒绝，未发变更命令。

| 违反要求的反例 | 最终处理 |
| --- | --- |
| R6/R8：5 个服务×64 个工具的合法 MCP 摘要使默认维护预检超过应答上限 | 维护预检 `limit: 1`；未决检查保持完整 |
| R2/R3：托管修订冲突被分类 unknown、读回 saved=null | `skills_revision_conflict` 加入已证明写前拒绝名单，保留未保存和恢复事实 |
| R6/R8：真实 systemctl 省略空 ExecStop/Post，合规单元误只读 | 仅这两个命令数组省略按空解释，非空及其他缺字段继续拒绝；依据[systemd v255 源码](https://github.com/systemd/systemd/blob/v255/src/systemctl/systemctl-show.c#L1374)与 Oracle 的空数组查询 |
| R3/R8：真实启动失败后 failed/MainPID=0 阻止显式恢复 | 已离线取锁且原身份核实后允许 failed 单元显式启动；不接受占锁、非零 PID 或启停中 |

文档责任上下文 `/root/acceptance_docs` 复核 README、usage、开发说明、模块、命令与笔记；已修正个人 HTTP 超时事实、设置测试导航与个人包过时问题。已实施切片保留 implemented 和代码锚点，总体提案因产品验收未完成继续 proposed。

## Oracle 真实运行

Oracle 普通账户 ubuntu/UID1001，Linux aarch64，Node v24.15.0，systemd 255.4-1ubuntu8.18；本轮源码 `/tmp/ruukoto09-acceptance-hpmga99g/source` 来自 HEAD archive并同步最终维护源/测试。依赖使用当前锁文件在独立目录安装，构建 worker、重建 node-pty；这些不改变生产安装。

开工只读确认固定服务、`/usr/local/bin/ruukoto` 与 `/opt/ruukoto` 均不存在。只在 `/run/systemd/system/ruukoto-backend.service` 建本轮临时固定单元，以 ubuntu、显式 Node/bin/档案、SendSIGKILL=no、terminate/SIGTERM/control-group 启动；不新增 sudoers，沿已有固定 start/stop 授权。拥有者指定 DeepSeek 凭据仅经 SSH 传入本轮 0600 环境文件，不读取既有 EnvironmentFile。`profile-new` 与 `profile-history` 均为本轮新建，不操作其他服务或档案。

真实结果：[Code 模型](09-code-real-model.jsonl)、[MyGo 打包宿主](09-oracle-host.jsonl)、[历史/失败初次记录](09-oracle-history.jsonl)、[修复后恢复](09-oracle-recovery.jsonl)、[丢答核实](09-oracle-loss.jsonl)、[清理](09-oracle-cleanup.jsonl)、[退出后的源与配置读回](09-oracle-persistence.jsonl)。历史初次记录的恢复失败是本轮缺陷发现，不能当最终通过；最终恢复文件保存修复后的独立实际结果。

模型共执行 Code 显式 ping、Personal 显式测试及一条不调用工具的短回答。历史档案原 8 条 entries 不变；Token 在重启后变化，旧修订/锁/未决输入拒绝，SSH shell 没有所选变量，实际服务仍能验证该引用。打包 MyGo sidecar 完成模型保存、远端技能导入/停用和退出；无诊断输出。保存丢答测试以真实 OpenSSH/固定后台完成写入后主动丢弃应答，重开原 journal 返回 unknown，读回当前值后显式恢复并结束，保存仅一次；这是客户端传输故障注入，不声称发生了自然网络故障。

已确认本轮固定服务退出，两档案锁可取得；移除临时 unit、程序链接及本机/远端凭据文件并 daemon-reload，固定服务恢复 not-found。两个档案、托管包字节及历史保留，档案字节扫描无所选认证值，model pi.tool 数为零；未启用 IM、未调用真实 MCP 或模型写工具。恢复体验验收需重新装本轮临时单元/链接与限定凭据环境文件，不能把已清理的连接显示为可用。

## 产品验收与恢复条件

下一责任人是拥有者。Electron 与 MyGo 分别验收明暗、窄窗、键盘/读屏名称、焦点、减少动态效果、未保存保护，Code/Personal 的模型新增、技能导入/停用、MCP 配置/发现/启停六流程，并退出重开核实持久性；最小回归还包括外观、旧 PA 连接、存档、会话模型菜单、新会话继承、审批和提交恢复。

Personal 可重新使用本轮保留的 Oracle 隔离档案：先恢复受支持临时部署与指定模型环境，再从 PA 新设置管理连接选择 `/usr/local/bin/ruukoto`、systemd 和对应档案；Code 使用独立测试档案，避免修改日常配置。真实 HTTPS MCP 需拥有者给出限定端点和凭据引用，只做连接/发现，不调用写工具。双壳原生操作或真实 MCP 仍缺证时，09 及整个设置功能均不标 resolved。
