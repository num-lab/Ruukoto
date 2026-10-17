# Code 后台进程冷启动耗时分析

日期：2026-10-17。被测提交：c19d63e。目标是定位桌面按需启动本地 Code 后台的主要等待，本轮不改变运行代码或决定优化实现。

## 结论

已有空档案正常退出后再启动，主要耗时是加载 Runtime 的模块依赖，约 0.66 秒；实际 Runtime.start 约 15 毫秒。全新档案首次启动还要创建系统角色会话，其中目录保护校验本轮约 402 毫秒。数据库建表、模型配置初始化、控制面监听和正式连接均不是主要耗时。

## 范围与方法

macOS arm64、Node 24.15.0，正式 ruukoto-code bin，默认 coding 工具与 native 后端，使用隔离的数据／agent／控制目录和本机模拟模型配置，不执行任务或调用模型。每次都在后台进程不存在时启动，随后通过该实例的控制面正常停止；不连接或停止日常后台。

保留系统文件缓存与正常 tsx 缓存，因此这是进程冷启动，不是清空 OS 磁盘缓存后的测量。分别测全新空档案首次启动，以及同一空档案第二／三次启动；没有把用户已有历史、未完成任务或浏览器遗留状态的恢复混入空档案结果。

先复跑旧隔离脚本，再进行 36 次正式 bin 主矩阵：默认 coding／显式 mock × 无探针／轻量探针，每组 3 个新档案，每个档案启动 3 次。轻量探针只给 bin、main、CLI 的阶段边界加标记；深层定位另做 4 次，目录定位另做 2 次。所有插桩和候选对照在临时文件或内存 loader 中完成，不修改被测仓库源码。源码摘要与清理结果见[证据目录](evidence/)。

## 正式入口总耗时

总时间从 ensureBackend 开始，到正式 ControlConnection 在线；包含启动前探测、派生后台、就绪轮询以及正式认证和快照，不包含 fixture 创建、桌面窗口或登录 shell。

| 无探针场景 | 样本数 | 默认 coding/native 中位数 | mock 工具中位数 |
| --- | ---: | ---: | ---: |
| 全新空档案 | 各 3 | 1209.8 ms | 1209.2 ms |
| 同一档案第二／三次启动 | 各 6 | 808.8 ms | 807.7 ms |

默认工具与 mock 工具差异很小；由于没有执行任务，不能把导入 native 相关模块的成本称为沙箱或工具工作进程启动成本。原始[主矩阵](evidence/matrix-results.json)与[分组汇总](evidence/matrix-summary.json)保留全部样本。

## 已有空档案的时间分布

以下取轻量探针、默认 coding/native 的 6 次重启，各阶段分别取中位数；它与上表无探针样本是不同组，中位数不能直接相加。轻量组总中位数 807.7 ms，与无探针 808.8 ms 接近，但 200 ms 轮询会掩盖小幅探针扰动。

| 阶段 | 中位数 |
| --- | ---: |
| spawn → Node preload | 23.5 ms |
| preload → bin body | 9.8 ms |
| tsx register 本身 | 1.3 ms |
| main 静态依赖 | 18.4 ms |
| Runtime 动态导入及其依赖 | 663.5 ms |
| ControlServer 模块导入 | 1.3 ms |
| Runtime.start | 14.6 ms |
| ControlServer.start | 0.7 ms |
| socket 监听完成 → ensure 检出 | 71.5 ms |
| 正式认证与快照 | 0.9 ms |

[正式入口](../../packages/tui/src/cli.ts)先动态导入 Runtime，再调用 Runtime.start，最后才开放控制面；ping 不绕过初始化。[ensureBackend](../../packages/control/src/ensure-backend.ts)在失败探测后等待 200 ms 再试，正常快失败时会增加约 0–200 ms 的发现延迟；负载或探测超时可能更长。缩短轮询只能处理尾段，不能消除 0.66 秒模块加载。

## 全新档案额外成本

轻量组全新档案的 Runtime.start 中位数是 447.7 ms，较已有空档案的 14.6 ms 多约 433 ms。进一步的两轮深层测量把新库 Runtime.start 定位为 454／442 ms，其中 orchestrator.start 为 433／427 ms；Db 为 3.5／3.2 ms，ModelRuntime 为 6.2／3.3 ms，其他装配与恢复较小。原始记录见[深层定位](evidence/deep-results.json)。

最后一轮目录定位：Runtime.start 424.5 ms → orchestrator.start 404.0 ms → createSession 的 resolveUsableDir 402.0 ms → assertGrantNotProtected 401.8 ms。这是单轮定位结果，不是多轮稳定中位数；同档案重启 Runtime.start 13.6 ms、orchestrator.start 0.7 ms，跳过首次角色创建。记录见[目录定位](evidence/dir-results.json)。

[ensureRoles](../../packages/runtime/src/orchestrator.ts)只为缺失的角色创建会话；[resolveUsableDir](../../packages/runtime/src/runtime.ts)调用[目录保护核实](../../packages/agent/src/execution/approved-ops.ts)来验证工作目录。证据支持首次角色目录保护核实是这部分差额的主要来源，不支持「数据库建表慢」或「在等待远端模型连接」的归因。任何后续优化须保留原来的保护拒绝语义。

## 模块装载的进一步证据

模块图观测记录 3186 个物理文件，其中 TypeBox 为 1942 个：根版本 1.0.12 的 622 个，以及两份 1.3.7 各 660 个；pi-ai 0.85.1 也实际加载两份。coding SDK 的根导出还带入 TUI、jiti/Babel 和语法高亮依赖。文件数量不是耗时占比；原始[模块统计](evidence/module-graph-summary.json)仅用于定位装载面。

有效 CPU profile 的运行约 755 ms，采样集中在 ESM 编译、文件读取／打开、CJS 包装、tsx 转换与 source map 处理，见[采样摘要](evidence/profile-summary.json)。实际 OpenAI／Anthropic／Google／AWS API SDK 实现不在该次模块图中；不能把 provider 定义加载说成远端 API 连接。

| 临时导入实验 | 结果与解释 |
| --- | --- |
| 私有空 tsx 缓存，再使用同一缓存 | 首次进程 1443 ms，后续 700／688 ms；不清理用户共享缓存 |
| 禁用 tsx 缓存 | 约 918–951 ms |
| Node 24 原生 TS 转换 | 约 696–723 ms，与缓存 tsx 接近；不能据此认为仅替换加载器即可显著加速 |
| 仅打包仓库 Runtime 模块、外置第三方且不注册 tsx | 导入进程约 466–476 ms；尚未验证为可运行后台，入口与完整 CLI 导入也不同，不能换算为后台提速 |
| 同版 pi-ai／TypeBox 副本的临时 URL 去重 | 三对样本进程中位 783→712 ms，但其中一对反向，噪声和样本限制明显；只是值得进一步验证的线索 |

tsx register 的 1.3 ms 不包含后续模块转换和装载。SDK 单项实验按 ai→providers→model-runtime→coding→runtime 顺序导入，后续阶段利用前序缓存，不能当作各入口的独立耗时。相关原始记录见[缓存实验](evidence/cache-results.jsonl)、[打包导入](evidence/bundle-results.jsonl)、[SDK 顺序导入](evidence/sdk-results.jsonl)和[同版去重](evidence/dedupe-results.jsonl)。

## 下一步优先级

1. 优先验证后台专用构建与依赖装载收敛，减少启动时逐文件解析、tsx 介入和不需要的 SDK 根入口依赖；同版副本去重可作为较小的独立实验。暂不承诺上述导入实验能直接兑现生产后台收益，也不直接绕过包 exports 使用私有 SDK 文件。
2. 若要优化首次建档，单独处理系统角色创建时的目录保护核实；这与日常已有档案重启是两个场景，不应混作同一优化结果。
3. 最后再处理就绪发现尾延迟。当前本轮约 72 ms，比模块装载小，不能靠减小轮询间隔解决主要瓶颈。

独立证据审查由 connection_plan_review 在另一执行上下文完成，通过，无阻断；审查者复算主矩阵中位数，核对阶段边界、模块物理文件、有效 CPU profile 和原始清理记录，并现查已记录 PID 均已消失。源码插桩、探针同步落盘与轮询均会影响观测，不能把探针结果当作完全无扰动的原始启动。

本轮没有确定实现方案、改动运行代码或提交。没有测 OS 磁盘冷缓存、Linux、真实模型、完整桌面启动或真实大档案恢复。所有 42 次正式测量后台均正常退出；日常实例保持运行。探针脚本与复跑说明保存在 evidence 下，包含本机绝对路径，复跑前须按说明确认隔离目录与工具链。
