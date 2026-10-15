# 工单 03 最终 Linux 验证

冻结主仓与独立 Linux 副本 394 个代码、测试与构建输入逐项 SHA 一致，含 179 个 packages/apps 输入；运行后源文件仍一致。root 指定 38 项子清单逐项 Linux sha256sum -c 为 OK，子清单总 SHA 为 `4d4080f7821db32e9f2217a0394603932167599bef2afe53e1c404a195e56ed7`。Linux Node v24.21.0 / Git 2.43.0 / kernel 6.8，npm run build 成功；实际 worker SHA 为 `ec4d123259d2ee502107d66c7598a5d88ad4a7551bf4ca9d3383cd3d70bdb909`，原始编译输出与 script worker/WASM 一并保存。

## 约定五文件

| 文件 | 首次结果 | 独立重跑 |
| --- | --- | --- |
| workspace-snapshots.test.ts | 22/22 | 无需重跑 |
| subagent-workspace-snapshot.test.ts | 3/4，结构化/批准入口例 child.status failed，errorMessage 为 Connection error. | 原文件独立顺序 4/4 |
| 101-native-linux-scope.test.ts | 3/3 | 无需重跑 |
| 125-agent-wait-resource.test.ts | 9/9 | 无需重跑 |
| 125-agent-wait.test.ts | 5/5，含两产品真实 worker 等待让出与非 Git ordinary 目录串行/审批 | 无需重跑 |

首次 42/43 的完整失败日志与原文件顺序 4/4 均保留，没有改 timeout、没有给产品添加 retry。窄诊断只复制单一失败用例为额外 test 文件，增加终态前保存 mock 请求、任务、tool ledger；前置 fetch hook 只捕获本地 mock HTTP状态和异常 cause 链，原生产/测试文件与 SDK 未修改。窄诊断 1/1，8份完整 mock 请求（7份 child HTTP200），6个真实工具操作均拒绝写入；唯一 fetch AbortError 来自 gate-held 父 prompt 在 test_end 主动收尾中止，不能解释首轮 child 连接失败。首次 fixture 已由标准 shutdown 清理，原 SDK cause 和完整请求未能恢复，首轮原因仍未知，不能将它确定为 timeout、资源不足或产品安全失败。诊断时 disk 尚余298MB、inodes27%used、user manager running、仅init.scope；不声称这些状态能反推首轮状态。诊断副本已移出远端活动 test 目录，原始版本保存在本归档。

## 真实执行证据

来源保护 probe 使用真实正式 native worker 与工具、OS 文件字节，策略装配的 role/store 是固定 fixture，不能将其称为真实模型或真实审批消费。两产品真实 Runtime reviewer 的模式收紧、当前 dirty/untracked 捕获与结构化/宿主入口由约定 subagent-workspace-snapshot 原文件独立4/4覆盖。来源、绝对/dot/symlink别名、共享 Git 与注册 index、额外 materials、私有 snapshot 均可读而拒写；副本检查产物可写，全部来源树内容前后完全一致，active hardlink 先停再拒绝，stopVerified=true。

最终对象 file-bind 真实 mount 探针仍拒绝 nlink=1 的 source-child 文件 alias（启动前、已启动单元下一调用、approved-host）和 empty-directory bind 内新文件的宿主写入。empty-dir native 由既有目录 inode guard 拒绝；源码内容与空目录不变，每个执行单元 stopVerified=true，host bind 全部 umount，fixture保留 `/tmp/rk03-bind-regression-g30374`。撤修红证据在另交 file-bind-evidence 归档，本次不再次修改最终对象。

正式 Linux scope 探针3/3：活动 detached 后代忽略 SIGTERM，整 scope stop=true、heartbeat字节停止增长并可重复stop；快速退出和worker入口前失败没有观察到cgroup身份，launcher stop=false保留未核实结论，外部 manager确认组已删除后仅清理探针。脚本中的程序是生命周期fixture，launcher/OS/scope是真实，不能把它说成授权装配验证。等待资源9/9中停止未核实保留占用属于注入返回false的调用方策略测试，真实目录与worker让出/重新执行及非Git串行另有实际文件证明；不冒称OS无法停止已运行单元的整链故障已模拟成真实。

Git2.43真实 partial clone 缺失blob拒绝capture，整个source/.git46项 bytes/mode/mtimeNs/size前后完全一致、added=[]，工作文件仍为unstaged-current。该证明使用portable只读对象视图，不依赖旧Git识别GIT_NO_LAZY_FETCH。fixture `/tmp/rk03-promisor-regression-GUJivK`。

本次不运行全仓check、不修改主仓或生产代码、不新增其他scope实现。初始失败、全部顺序重跑与窄诊断、SHA清单、编译物、脚本和源/fixture报告均以原始文件保存，manifest逐项 SHA 校验通过。
