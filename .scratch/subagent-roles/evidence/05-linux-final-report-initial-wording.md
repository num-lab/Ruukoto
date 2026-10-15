# 工单 05 Linux 最终证据

最终 v6 的 TUI 整文件 35/35、来源与等待恢复 30/30，以及完整静态检查全部通过；两组测试均 0 跳过、0 取消。此前 v4 的正式整仓检查仍为 exit 1：应用 1644 通过、1 条旧夹具失败、13 跳过，唯一失败已由最终 TUI 整文件复核覆盖。没有声称最终 v6 执行过一次全绿的 npm run check；这些证据供 ready-for-human 收口，保留原始失败。

## 固定输入

v4 官方 620 项源码清单 SHA-256 为 `1449bb2511217e747b752cf8e0006327cf6d23a642856dd011d1ef35b738e8af`，最终 v6 为 `8e4c67ee72fcada1910073e6a5063341cf9fbd515f4293134ed1332a102ae0fa`。v4 完整工作输入 1552 项，结束后全匹配、Git 干净；v6 前后 620 项全匹配，完整 1552 项相对 v4 仅 `packages/runtime/src/runtime.ts` 的机械 try 范围修正与 `test/14-tui-app.test.ts` 的夹具同步改变，其他 1550 项未变。最终实际发现的 169 个 app `*.test.ts` 与冻结源码清单完全一致，Git 干净。

源码和文档必要材料均固定传输，v4 更新包覆盖全部 620 源码及 116 项常驻 Markdown 引用的 scratch 文件（两者有重叠，共734项）；继承原已固定材料后合为1552项。31个未被这些入口直接链接的历史压缩包单列排除，没有为缺材料修改文档链接。归档内 `full-v4-raw/full-check-inputs-v4.json`、`full-v4-raw/full-check-v4-update-inputs.json` 和 `full-v4-raw/required-scratch-v4.json` 保存完整清单与排除依据。完整 v4 源码快照 `full-v4-raw/full-check-v4-source.tar.gz` SHA-256 为 `dd1b7c1626b5235344436ac57dcf0d55a65abd921ea42ebf5634144a2084c8ad`，1552 个成员全部本地逐项读回核实；用最终两文件字节覆盖后，再逐项核实官方 v6 的全部620项。

主区基点为 `5f9da455072d68180ef19fc92ad02070cea583c1`，本轮交付源码以冻结清单为权威；远端为本次唯一 `/dev/shm/rk05-linux.ZHrgZC/repo`，临时 Git fixture 提交只服务安装和测试，不冒称主仓提交。未修改主工作区或现有实例数据。

## 正式完整检查与补验

| 对象与命令 | 实际结果 | 实际外层耗时 |
| --- | --- | ---: |
| v4：`npm run check` | exit 1；app 1658项，1644通过、1失败、13跳过、0取消 | 1520.285341秒 |
| v6：`npx tsx --test test/14-tui-app.test.ts` | 35/35、0失败/跳过/取消、exit 0 | 79.182878秒 |
| v6：`npx tsx --test test/subagent-result-source-boundaries.test.ts test/125-agent-wait-recovery.test.ts` | 30/30、0失败/跳过/取消、exit 0 | 24.307298秒 |
| v6：`npm run check:static` | lint、各包/基础包typecheck、notes与docs全部通过、exit 0 | 133.177030秒 |

v4 正式检查于 04:36:35.815–05:01:56.101 UTC 自然完成，build 与全部静态门通过；app 内部1382.899秒。保持原 `npm run check` 与 Node 默认应用并发3，唯一正式校准是六输入样例的报告等待90→180秒，产品查询、脚本、工作流运行时限及其他测试预算不变。该正式六输入完整例本轮通过，用例174.421秒，原共享三个名额、实际字节、冻结验证、账本、唯一回报与停止断言全部保留。

v4 唯一失败原栈为 `test/14-tui-app.test.ts:291:12`，`单条补读不依赖任务元数据` 的 deepStrictEqual 期待 `[]`，实际已由仍运行的 app 恢复一条合法拥有者输入 `启动工作`，并无内部工作流原文。确切 actual/expected/stack 原文在归档内 `full-v4-raw/full-check-v4-failure.log`，全 stdout/stderr 在 `full-v4-raw/logs/full-final-check-v4.log`。独立门控确认异步恢复竞态后，最终夹具用未启动的独立 TuiApp/ViewState 实际读取内部 entry，再使详情后到；保留实时、重连、分页、↑、sticky、search 与原始 entry 实际读入保障。最终35项包含此例与原长正文48KiB分页例。Runtime 的另一变化仅机械收窄 try，独立 AST 顺序/typed catch 等价审查及最终 Linux 30 项均通过。

v4 的13个 app skip 是7个显式真实模型 gate与6个 macOS专属用例，没有缺Python/PTY跳过。app失败导致原 `npm test` 的 `&&` 短路，foundation 没有作为这次完整检查的一部分执行；按拥有者批准复用此前相同基础包/依赖的独立 foundation 9通过、1真实模型gate、exit0证据，不伪称本轮完整check成功。前一轮 v1 完整检查同样 exit1（1640通过、5失败、13跳过、1507.241秒），原记录已另行保全，不被本包覆盖。

## 有限等待诊断与额外文件排除

归档内 `diagnostic-122/` 保存原正式90秒单跑失败（109.045秒）、原源码、唯一180秒临时诊断副本、精确差异、转换脚本、输入和原 stdout。诊断仅延长观察并对该wait做一次monotonic记录，原stderr为 `reportWaitMs=110375.362817, reported=true, limitMs=180000, formalLimitMs=90000`；全部原断言通过，整命令129.295秒。该诊断不是正式全量通过。随后独立审查才正式校准180秒，v4整仓中也实际通过。

该临时文件采用不匹配 `*.test.ts` 的名字，并在源码字节保全后单项删除。归档内 `full-v4-raw/122-diagnostic-cleanup.json` 与 `full-v4-raw/full-check-v4-diagnostic-exclusion.json` 明确保存删除时间/备份SHA、正式v4启动前显式不存在、启动Git干净、完整1552清单不含路径、完整检查结束后仍不存在；不以620匹配推断无额外文件。最终v6也显式核实此路径不存在与实际169个app文件集合一致。

## 环境与执行边界

实际为普通用户 UID1003、Linux6.8 x86_64、Node24.21.0、npm11.19.0、Git2.43.0、bubblewrap0.9.0；4个可用CPU，正式默认应用并发3，user systemd running、cgroup v2、正式 bwrap/AppArmor配置存在。所有源码、依赖、缓存与TMPDIR均在本次私有tmpfs根；未清其他目录、改变系统配置或增加执行资源预算，未并发其他外部测试或探针。环境原文在 `full-v4-raw/full-check-v4-environment-before.json`。154次只读采样最低 MemAvailable793880KiB、SwapFree117144KiB、tmpfs可用488120320字节，原文在 `full-v4-raw/logs/full-v4-resource-samples.jsonl`。

最终三实际编译物字节与 v4/原 Linux 基线相同：worker.mjs SHA-256 `ec4d123259d2ee502107d66c7598a5d88ad4a7551bf4ca9d3383cd3d70bdb909`；workflow-script.mjs `2e6719fd380b60ee89d7b1708de3fac33f169b398b5c73b5880a7f61b8dcf930`；workflow-script.wasm `105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232`。原字节在 `full-v4-raw/repo/worker/`，最终结束复核在 `final-v6-raw/final-v6-source-after.json`。此前固定5f原生73/73、HTTP19/19、正式Linux scope探针3/3、来源消费121/121及恢复5/5均已有独立归档，本包不把它们混成最终源码的一次命令结果。

所有完整命令、退出、UTC与耗时分别保存在两个 `logs/` 目录的 `.command.json` 和 `.log`。归档内 `final-v6-raw/` 还保存最终前后620项、完整1552项、两文件实际字节与补丁。顶层 `linux-final-manifest.json` 是文件路径、字节数和SHA-256数组，覆盖其余全部有效载荷；整包另有SHA-256。远端只在协调者与独立审查者确认复制/哈希后清理本次独有目录。

本 Linux 任务没有运行真实模型、真实IM或部署；外部模型/产品验收由既有独立证据另记。仍需如实保留两次full exit1与最终没有单次全量绿的限制，不能把分层补验改写为一次最终全量通过。
