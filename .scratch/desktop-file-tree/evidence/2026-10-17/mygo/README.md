# 隔离 MyGo 文件树验收

只写本临时目录。先由根代理在仓库运行 `npm run desktop:mygo:build`，不要运行会连接日常后台的 `desktop:mygo`。

准备应用：`node /tmp/ruukoto-mygo-file-tree-qa.cNYsDo/prepare.mjs`。复制的 Go 宿主修改窗口标题并增加可信顶层调用的固定文件计时报告方法，QA renderer 增加被动 perf.js；应用名和 identifier 独立。`source-hashes.json` 记录复制时生产源码与原构建资源，`artifact-hashes.json` 记录 QA 可执行包、脚本及插入探针的 index。

启动夹具：在仓库目录执行 `node --import tsx /tmp/ruukoto-mygo-file-tree-qa.cNYsDo/fixture.mts > /tmp/ruukoto-mygo-file-tree-qa.cNYsDo/fixture.log 2>&1`。保持该进程，由 CUA 选取 Ruukoto File Tree QA 窗口进行原生操作。ready.json 记录 PID 和临时路径；不打印令牌。

CUA 顺序：选择性能验收会话，打开右侧新标签页，选择文件树；展开 sample-dir，收起后再次展开；展开 empty-dir；关闭文件树后再开。每个展开结束后读取 AX 中的文件树性能验收 JSON，再截图。perf.actions 的 rowsMs 是原生点击 capture 至可视区域行进入双 rAF 的上界；perf.requests 是同一真实 bridge 的往返；expectedCache 为 true 的动作必须 requestIds 为空且 passed 为 true。不要将 CUA 自带等待时间计入 UI 指标。

server-measurements.json 保留 30 个直接控制面样本和每次真实 Runtime.listWorkspaceFiles 的服务端时间，phase 区分 baseline 与 ui。直接控制面和桥接请求并非同次采样，不直接相减声称精确桥接成本。

通过 CUA Cmd+Q 正常关闭 QA 窗口后，夹具自动 t.shutdown() 并删除临时 profile/control，cleanup.json 记录结果。若原生退出失败，只向 ready.json 中本夹具的 app PID 发送 SIGTERM；不要按应用名广泛 pkill。夹具正常收尾后检查相关 PID 消失、profile/control 不存在。保留本临时目录测量与哈希，交付时按根代理选择复制证据。

空目录以“暂无文件”完成可见检测。只读的缓存重展断言依赖真实桥接调用计数，快照或离线会清空探针期望，与产品缓存失效一致。探针改变测试产物并增加轻微观察成本，结果仅用于本轮隔离验收；未执行前后 MyGo 版本对比。

第二轮：AX 单个文本节点有截断，QA Go 副本增加 `Desktop.ReportFileTreePerf`；只接受原 `trusted` 顶层窗口、合法且不超过 1 MiB 的 JSON，写固定临时 `metrics.json`。perf.show 异步上报完整 JSON，计时已经结束后才调用；无路径参数，未增加任何产品接口。生产源码不变。第一轮证据保存在 round1/，第二轮当前文件在本目录。完整 actions 和 requests 直接读取 metrics.json，AX 仅用于真实页面验收。
