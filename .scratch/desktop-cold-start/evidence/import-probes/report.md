# Code 冷启动：模块装载诊断

基点 `c19d63e`，macOS、Node `v24.15.0`，只读生产源码、仅写本目录。所有试验仅动态导入模块，不启动运行时、不连接模型或日常后台。与 backend_connect_perf 的正式后台基准分时执行。工作区未修改。

## 结论

- 已有 tsx 缓存时，cli→product→runtime→control 依赖导入本身仍约 0.66 秒，和正式后台分阶段约 0.64–0.66 秒的 Runtime import 一致；主要成本在模块读取、解析、链接和顶层求值，而不是仅 1.4ms 的 register() 调用。
- 空私有缓存会额外拖慢：新 TMPDIR 首轮进程 1442.9ms，随后同一缓存进程 699.5/688.0ms；不能把这个首轮数字当日常启动，因为日常默认使用已有缓存。禁用 tsx 缓存三个进程 938.3/950.7/917.5ms。
- 直接换 Node24 原生 transform-types 的三个进程 723.3/695.7/703.1ms，与缓存 tsx 接近；它只是诊断对照，不是跨 Node22/24 可直接采用的优化方案。
- 模块图有 3186 个 file URL。TypeBox 三份合计 1942 文件（根 1.0.12 共622，pi-ai 私有1.3.7共660，pi-coding-agent私有1.3.7共660）。pi-ai 0.85.1 的根副本和 pi-coding-agent 私有副本均装载（171与172文件）。pi-agent-core、pi-tui只装载SDK私有副本，不能称它们重复装载。
- 同版本副本去重的 URL alias 对照：一热身、三成对轮，进程中位 783.2→712.0ms、script阶段中位750.0→680.2ms。但第2对 alias 890.6ms 比 before757.9ms 更慢，噪声明显；只支持它是可探索的小优化点，不能承诺稳定省70ms或替代完整优化。根 TypeBox1.0.12 未重定向到1.3.7。
- pi-coding-agent 根入口确实拉入 main、InteractiveMode、TUI、jiti/Babel、highlight.js 等。native TS 顺序增量实验的三轮中位：pi-ai59.2ms、providers16.4ms、内部ModelRuntime84.8ms、随后完整coding入口185.4ms、Ruukoto Runtime294.7ms。各阶段依赖互相复用，不可把这些值当独立可删除收益，也不可建议生产 deep import 未公开路径。
- provider 全目录虽被装载，但其实际API实现采用lazy导入；本次模块图里 OpenAI/Anthropic/Google/AWS SDK 实现为0。不能把约640ms归因于连接这些远端 provider。
- 仅把116个仓库TS输入bundle为1.85MB模块、三方保持external：无tsx的三个进程465.9/476.1/471.6ms；仍注册tsx时640.0/637.5/639.5ms。这是import-only可行性对照，未调用 Runtime.start，bundle的import.meta路径/worker/资源/动态require/产品语义均未验收，不能视为可发布后台。

## CPU profile

有效 profile 是 `CPU.20261017.112523.35487.0.001.cpuprofile`，总755.25ms。`CPU.20261017.112508.34871.0.001.cpuprofile` 是修复测试脚本前的失败短运行，不用于结论。

主要self采样：ESM compileSourceTextModule126.1ms，readFileUtf865.5ms，open36.2ms，CJS wrapSafe31.4ms，tsx的两个主要URL合计82.8ms，source-map-cache50.9ms。profile运行总导入约743.8ms，比无profile约658–667ms更慢，采样有开销；内部节点的时间不直接归因到某一个SDK。

## 可复现入口与原始证据

- `node measure.mjs cli product runtime control`：缓存/无缓存/native TS 对照；结果 `cache-results.jsonl`。该脚本的 cached TMPDIR 首次运行会产生缓存，重复执行不再代表首轮；没有删除系统全局tsx缓存或OS页缓存。
- `node --cpu-prof --cpu-prof-dir=. import-only.mjs cli product runtime control`：CPUprofile；计时 `profile-stages.jsonl`，解析 `profile-summary.json`。
- `module-observer.mjs`：只记录file URL、格式、返回source字节数及依赖边，不保存源码或环境；结果 `module-graph.json`、`module-graph-summary.json`、`module-graph-stages.jsonl`。
- `node measure.mjs ai providers sdkmodel coding runtime control`：SDK顺序增量；结果 `sdk-results.jsonl`。这些前置动态import会改变加载顺序，因此优先用native三轮稳定数据说明依赖范围，不能直接分摊正式后台关键路径。
- `node build-bundle.mjs` 然后 `node measure.mjs /tmp/ruukoto-cold-import-audit/runtime-bundled.mjs`：仓库模块bundle import-only对照；`bundle-build.json`、`metafile.json`、`bundle-results.jsonl`。
- `node measure-dedupe.mjs`：一热身+三成对进程，before与alias交替，使用同一私有已建立缓存；`dedupe-observer.mjs`只将同版本pi-ai与TypeBox1.3.7私有副本映射到另一份相同版本。原始 `dedupe-results.jsonl`，汇总 `dedupe-summary.json`。

以上命令以本目录为 cwd；脚本固定当前工作树绝对路径；复现前应核实HEAD/Node/依赖未变。没有重启日常实例，没有做磁盘冷启动、Linux或真实模型网络验收，也没有改生产代码或安装依赖。
