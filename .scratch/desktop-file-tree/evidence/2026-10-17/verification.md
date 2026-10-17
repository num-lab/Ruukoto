# 文件树目录读取性能验收

## 范围与版本

基点为 632db30，当前未提交内容的生产代码哈希见 source-hashes.json；Linux 和 MyGo 各自另存实际受测源码哈希。只增加目录列表的保护核实入口，文件预览、通用宿主保护、前端样式与缓存策略未修改。使用真实 Runtime／ControlServer、本地确定性模型和独立工作区，不连接或重启日常实例。

## 工程检查

- 作者先在旧实现执行新增目录保护回归，根及 src 两例各逐文件读取 800 次元数据，分类竞态例缺少预期拒绝；修复后 `npx tsx --test test/desktop-workspace-files.test.ts test/subagent-execution-core.test.ts` 13／13，通过日志为 targeted.log。
- `npx tsx --test test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts test/desktop-inspector-tools.test.ts` 94／94，通过日志为 regression.log。
- `npm run check:static`、`npm run build`、`npm run desktop:mygo:build` 通过，分别见 static.log、build.log、mygo-build.log；MyGo 构建入口已执行严格签名校验。新增测试后的最终静态结果另更新 static.log。
- 独立实现审查亲验定向 5／5、附加正反例 6 项；独立 loader 在临时副本精确去除元数据稳定性护栏后，分类竞态回归 1 红。脚本、命令、输出与源码未被修改的哈希证明保存在 independent-review/。

## 后台基准

`npx tsx .scratch/desktop-file-tree/evidence/2026-10-17/benchmark.mts` 调用真实 listWorkspaceFiles，相同目标返回值逐字比对；保护目录固定为 50 目录与 5000 文件，另以本项目代码树作单一保护根读取临时空目录。计时不含模块导入、进程启动和 fixture 创建，未清 OS 缓存；后续样本表示进程内重复读取，不是冷磁盘。before 来自基点诊断脚本，after 使用等价探针，临时目录深度和新增少量证据目录有所不同，因此不把微小差异解释为优化收益。

| 场景 | 优化前后续样本中位数 | 优化后后续样本中位数 |
| --- | ---: | ---: |
| 相同 27 项根目录，5000 文件保护树 | 34.260 ms | 4.682 ms |
| 临时空目录，整个代码树为保护根 | 1578.582 ms | 408.285 ms |

空目录代码树场景，lstat 从 395214 次降至 36498 次，readdir 从 36428 次降至 18246 次；新增证据使后一次目录总数略增。原始样本见 benchmark-before.jsonl、benchmark-after.jsonl；基点源码身份见 baseline-source-hashes.json。另保留 benchmark-after-under-load.jsonl：该次与回归测试并行，代码树样本约 1.1 秒，不用于空闲前后比较；发现资源争用后顺序重测，不删除慢样本。

## Linux 安全验收

通过 `ssh tx` 在 Ubuntu Linux 6.8 x86_64、Node v24.21.0 的独立 bubblewrap user／mount／pid／network namespace 中，复制四份实际源码运行真实 listWorkspaceFiles，未使用 sudo 或修改宿主挂载。7 项检查全部通过：普通目录允许，保护子目录 bind 为工作区根／子目录均拒绝，读取中新增保护 bind 关系且工作区 dev／ino 不变仍拒绝，旧普通文件 Dirent 被替换为目录 bind 后拒绝，卸载后正常目录可读。linux-bind/ 包含 fixture、命令、结果和哈希；结束 remainingMounts 为 0，远端临时目录已清理。

## 实际 MyGo 点击链路

使用独立 `Ruukoto File Tree QA.app`、userData、控制目录和临时 Runtime；根目录 30 项、sample-dir 200 项、empty-dir 为空。生产 renderer／sidecar 按源码构建，QA 副本仅增加被动点击／bridge／DOM 观察器及向固定临时文件写计时 JSON 的可信方法；没有产品埋点或修改缓存。source-hashes 与 artifact-hashes 记录编译来源和独立应用身份，QA-only 原生报告方法保存在 mygo/qa-shell/。

原生 CUA 真实点击，开始点为 trusted click capture，终点为对应目录有视口内行或空态并经过双 requestAnimationFrame；这表示 DOM 已到可绘制帧，不声称测得显示器实际发光时间。bridge 从真实 window.ruukoto.request 发出到完成；同轮后台包装仅测实际 listWorkspaceFiles。后台与 bridge 按唯一 UI 路径和顺序配对；30 个预热控制面样本另存，不混入首次 renderer 缓存读取。

| 动作 | 后台 | bridge 总往返 | 点击至可绘制内容 |
| --- | ---: | ---: | ---: |
| 首次打开根目录 | 477.808 ms | 481 ms | 517 ms |
| 首次展开 200 项子目录 | 489.641 ms | 492 ms | 535 ms |
| 缓存重展子目录 | 无请求 | 无请求 | 46 ms |
| 首次展开空目录 | 463.617 ms | 465 ms | 518 ms |
| 关闭重开文件树 | 无请求 | 无请求 | 34 ms |

5 个动作均通过，只有 3 次目录请求。AX 与截图确认目录、子项、空态及原布局正确。完整指标见 mygo/metrics.json、mygo/server-measurements.json 和 measurements-summary.json；截图为 mygo/expanded.jpg、mygo/reopened.jpg。第一轮单个 AX 文本截断，保留于 mygo/round1/；第二轮改用 QA-only 固定文件报告后重新执行全部动作，第一轮不充作完整验收。截图对应第二轮，SHA256 见截图清单。

## 结论与限制

工程检查、独立代码审查和实际安全／外壳检查均通过，最终文档与证据独立复核通过（file_tree_latency_audit，2026-10-17），截图清单已按实际 JPEG 格式与尺寸修正。目录列表不再逐个 lstat 保护树普通文件，读取前后独立复核和分类变化拒绝得到回归证明；通用文件保护与预览保持。可见布局与交互经隔离 MyGo 核实，主观速度由拥有者日常体验继续确认。

整个代码保护树仍有约 9100 个目录，首次 UI 读取仍约半秒，主要耗时在后台；保护目录仍需枚举其条目，此次没有引入异步线程、监听缓存或预取，后续是否改变目录保护算法另行讨论。不承诺整树原子快照，不包含真实外部模型、日常用户资料或全平台性能比较。QA 应用正常退出，profile／control／Runtime 已删除，独立进程清理观察见 mygo/cleanup-observation.json；生产构建已更新，日常应用和后台未重启，未提交或推送。
