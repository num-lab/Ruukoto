# 工单 39 独立证据映射

审计对象：`b1e975437f4cd3ca8084a8b07e451f19ba80ba17`。本上下文只读仓库，未修改产品、工单或生产。2026-10-18；实际亲跑环境 macOS arm64 / Node 24.15.0。

## 当前内容与旧证据的对应

- `evidence/owner-acceptance-2026-10-18/candidate-source.json` 的 658 个源码、测试、构建、依赖文件与当前 HEAD 全部逐字节一致，0 changed/missing。含根 package/lock、foundation lock、双 app package、build-native/build-workflow-script/test-app。故该轮 model-smoke、正式PTY和真人CLI事实在当前候选直接有效，范围仍依原README，不扩大成真实IM或组合通过。
- `evidence/38-product-entry/pack-macos/source-manifest.json` 4045条中当前64个文件内容变化，另有符号链接/删除声明9条。没有任何 apps/*、锁文件或构建脚本差异。运行源码差异是 `packages/agent/src/driver.ts`、`session-factory.ts`；`packages/core/src/product.ts` 旧记录已证明只注释变化。其他为文档/工单/测试调用方。
- `evidence/38-product-entry/linux/source-sha256.txt` 569文件中20差异：同两份共享提示源码和18个测试/助手。个人入口、CLI和worker/helper叶测本身仍有效，但不等于最终全部共享运行文本验收。
- `evidence/37-current-live-flow/source-manifest.json` 12项中5变化：`personal-cli.ts`、`personal-work.ts`、`personal-delegation.ts`、`personal-report.ts`、`personal-command-work.ts`。37实际服务/IM/效果计数是历史叶事实；报告措辞、截断/污染及受影响工作收尾要按最终源码重验。
- 28–35的旧部分清单包含明显后续源码漂移，不能直接逐单转为当前组合通过。详见两个 manifest comparison JSON。

## A1–A12 证据阶梯与必要残项

| 项 | 可复用的证据入口（相对 `.scratch/personal-pi-durable/`） | 当前必须补齐/不能声称 |
| --- | --- | --- |
| A1 | `evidence/38-product-entry/pack-macos/acceptance-summary.md`：干净完整workspace setup/build、tgz实际解包、双Pi解析、12/12入口/worker；`evidence/36-coding-regression/README.md`：Coding旧schema/历史/产物与已修停止回执竞态；`evidence/38-product-entry/shared-prompts/ruukoto38-scheduled-prompt-summary.md`：晚提示SDK/HTTP快照且工具清单不变 | 原17精确失败机制、native101 identity_unavailable、宽批次112/118/125/22/45/83/snapshot/role及个人超时/中断；固定同候选完整workspace/产物；规定OS/Node范围。不能拼累计绿数。 |
| A2 | `evidence/31-qq/README.md` 离线双平台去重/共享；`evidence/37-current-live-flow/README.md` 真实TG聊天并行；owner当前CLI输入已验 | 真实QQ/TG交叉共享上下文、重复/重投与图片；31只保留私人账号不可代理动作，其余工程准备由Agent。 |
| A3 | `test/personal-work.test.ts` 忙碌占用/取消A不影响B/迟到结果、强杀恢复；37历史真实取消后复用 | 当前来源组合及真实原进程停止核实、多委托取消隔离；取消事实/效果/外部停止分别核实。 |
| A4 | `test/personal-scheduler*.test.ts` 的时区/DST、漏期合并、派生子工作/封组；`evidence/32-scheduled-work/` | 当前真实IM近期计划→子业务结束→唯一原入口报告，同时聊天继续；取消/恢复整项链。 |
| A5 | `evidence/25-linux/README.md`、`26-linux/README.md` 的真实受限/完全访问原语；37历史三模式、TG原审批/长期授权/撤销；35/owner当前模式与空授权真人事实 | 当前Linux真实受限探针、审查失败转人工、跨入口/配置代次、长期授权撤销对子/定时来源的组合；不能要求真人重复已验菜单。 |
| A6 | 应用数据崩溃回执：`test/personal-app-data.test.ts`；命令回执：`test/personal-command-work.test.ts`；HTTP/MCP/browser各自恢复测试；37历史命令强杀未知 | 服务效果后结果前真实崩溃、原检查停止与原菜单双事实；命令/HTTP/MCP/browser分别按各自远端结束证据，不能互替。当前跨工具同来源暂停/他项继续。 |
| A7 | owner `model-smoke.json`/`.log` 在同658文件候选上真实DeepSeek memory→重启→原version查询/read、skill、应用表两行/重启查询；28–34历史离线/真实OS叶证据 | 真实MCP端点/凭据、helper测试服务、HTTP/Tavily、浏览器/视觉、资料/记忆撤销及双平台业务组合；缺资源明确待验。 |
| A8 | 本次 `/tmp/ruukoto39-map-a8-a9.log`：69/69；覆盖三API两阶段存储失败零HTTP、onPayload改写、记忆/技能/图片原引用、原生compaction保留原历史；旧30实际SDK三API图片payload与33非空来源快照 | 动态工具/最终所有能力组合的完整请求重建仍须按实际启用范围核实；不能把准备快照计数当HTTP送达数（旧30已有2准备/1HTTP反例）。 |
| A9 | 同69/69包含真实SQLite互斥、缺扩展/旧扩展/旧doc/task拒绝、模型流SIGKILL恢复、持久写故障零HTTP/放锁；38实际bin双进程拒绝 | 各工具真实中断、未知外部操作与扩展恢复组合；规定OS/Node范围。静态/主测试通过不解释native101历史失败。 |
| A10 | `test/personal-reports.test.ts` 原发送键、发送后强杀未知不重发/固定原消息/换代；37真实唯一TG固定报告，正文“仅留本机”错述保留 | 当前报告路由叙述准确性、旧上下文污染、长答截断；真实双平台与定时原入口唯一报告；IM/HTTP/MCP未知送达分别核实。 |
| A11 | owner当前同字节正式PTY/首次配置/模式/授权/在线拒绝/消息和退出重连查询；`test/personal-cli.test.ts:132/155/173/243` 协议残项已提供最窄回归 | Agent补协议层执行中断开与原键核实，不再请本人做已跳过菜单；有数据/恢复菜单及其余能力配置按真实工程证据覆盖，不把空列表通过当全配置通过。 |
| A12 | `deploy/systemd/README.md:61` 与spec切换步骤；QQ/TG配对边界离线用例可作叶证据 | 没有现成完整隔离演练。必须在专用Linux档案做旧backend自动重启停用＋独立scope停止、冻结归档清单、真实平台边界反例、旧已登记入站/pending通知/active计划/未知执行不重放、旧代码用另一空白档案回退。生产只归40。 |

## 候选制品最小要求

1. 固定当前完整workspace源和两份锁文件，不只双 app tgz。双tgz依赖workspace包和根worker，当前不是独立发行包。
2. 若apps源码与已有实际pack清单相同且产物SHA一致，可复用原干净安装/实际解包12/12，不为同字节机械重装。晚共享driver/session-factory必须作为完整workspace候选的一部分，并附现有实际SDK/HTTP快照、必要Code调用方重验。
3. 保存 `npm run build` 后的五项worker/监督器/WASM与双tgz SHA；Linux监督器/原生后端以本平台构建/身份为准。另记录依赖真实解析来源：个人Pi/chord/durable 1.3.0，Coding Pi 0.85.1。
4. 旧Linux38是tx Node24.21.0，复用 `/opt/ruukoto` 依赖＋个人最小prefix新装；不是完整workspace干净安装，也不是规定Node24.15或22.19。CI实际矩阵见 `.github/workflows/check.yml`：Ubuntu24.04/macOS15 × Node22.19.0/24.15.0，不能将macOS27/Node24.15和Linux24.21拼作全矩阵。
5. 39最终结论按每项有效源码范围、实际环境、精确命令/退出、原始失败和未验字段陈述；独立审查不能由作者自检替代。缺真实QQ或视觉等要保留对应待验，不能resolved生产门。

## 本次亲跑

`RUN_MODEL_CHECK=0 node --import tsx --test --test-concurrency=1 test/personal-durable.test.ts test/personal-memory.test.ts test/personal-skills.test.ts test/personal-history.test.ts test/personal-media.test.ts`：exit0，69/69，0失败/取消/跳过，12275.502791ms。日志、命令/环境、hash在 `/tmp/ruukoto39-map-a8-a9.log` 与 `-summary.json`。测试只使用临时档案和回环mock模型，不是真实模型/IM，也不关闭完整A8/A9或整个39。

未跑全量、Linux/Node22、实际打包/部署或外部账号操作；残项与平台风险如上。
