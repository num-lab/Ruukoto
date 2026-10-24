# Agent Note: macOS 受限启动标记完整写入后发布

Status: implemented

## 问题

可信 Node 在加载 worker 前直接写 native-started；文件先创建再写内容。宿主每十毫秒核实该标记，读到空内容就按坏标记拒绝启动并保留停止未核实。Node22/24 的受控写入窗口均复现该竞态；它可导致真实受限工具启动失败，但没有完整子任务现场的历史 reviewer 超时不作唯一归因。

## 决定

可信 bootstrap 先在同一私有临时目录完整写入 native-started.tmp，再 rename 到 native-started，随后才 import worker。prepareNativeLaunch 每次新建独立 0700 目录，生产调用方不复用 prepared 输入；固定临时名不增加跨任务共享、锁或权限。临时文件不作为启动证据，写入或发布失败直接终止 bootstrap，不加载 worker。

宿主仍要求监督器 started 与完整标记两份事实；缺失在原五秒预算内等待，坏值与不可读立即失败。机器错误分类、错误携带单元身份、十二秒停止预算和停止未核实时保留占用及目录的规则保持。原子 rename 只保证发布对读者完整，不宣称断电持久化或与其他状态原子。

## 既有笔记审计

[原生受限执行](../architecture/2026-10-10-native-execution-sandbox.md)部分重叠：保持平台边界、可信标记与停止核实，仅补足标记发布方式。[等待可观察阶段](../testing/2026-10-11-await-observed-async-phases.md)部分重叠：回归在宿主真实读取写入窗口后才放行，不靠固定延时。[令牌原子发布](2026-10-24-personal-token-atomic-publish.md)使用相同发布原语，承载不同入口与失败归属，不合并。按 native-started、启动标记与原子发布检索，没有同题提案；Linux 持久身份和持久 macOS 后台不消费本启动标记。

## 备选方案

- 把空内容当作稍后重试会放宽坏标记拒绝，也把发布责任交给读端，故保持严格读取。
- 延长启动期限或让测试预热不能消除创建和写入之间的窗口，故保持原预算。
- 增加通用发布助手或启动协议会扩大调用方，本处沿已有临时文件加 rename 的本地写法。

## 后果

成功后只有完整 final 标记；发布前中断可能留下临时文件，仍由原单元生命周期决定保留或清理。现有真实 Seatbelt 用例扩展受控 open/write 停点，保留宿主 FD 不继承、原缺标记拒绝与停止身份。额外坏值、写入及 rename 故障证明 worker 未加载，负例的 stop=false 不因后来观察到进程退出而改写。独立审查与完整证据见[修复工单](../../../../.scratch/ci/issues/05-publish-native-marker-atomically.md)。
