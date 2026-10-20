# 本机 durable 命令验收

macOS / Node 24.15.0。基点 `9976721454118bff819e5cb3c91927d52319418b`；29 个实施、测试和说明文件由 source-manifest.json 与 source-final.tar.gz 固定。工单记账及证据不在该源码清单中。模型使用 MockModelServer；新命令用例运行真实 Node worker，但 Linux OS 调用采用系统桩，不作为 macOS 沙箱或真实 Linux 证明。

personal-final.log 对应 15 个 personal 测试文件：440 项中 439 通过、1 项既有 Linux 专用跳过；最后只新增 online faulted 用例，faulted-final.log 为 1/1。native-tests.log 对应 worker、原生执行/认领、scope 及产品入口五文件 53/53。合并覆盖 494 个唯一场景，493 通过、1 跳过，不把旧基线或重复复跑累计进去。strict-final.log 最终复核严格停止、活调用、停止先手及启动中取消 8/8；测试清理的 lint 修正不改变生产代码。

setup.log、build-final.log、static-final.log 和 docs-final.log 保存实际检查输出；最终 setup、build、check:static、docs 与 diff 检查通过。初始基线 baseline-147.log 为 147/147；cli-42.log 为 41 通过、1 Linux 专用跳过，均被最终集合覆盖。没有跑全量 npm run check。

model-snapshot.json 来自同一 MockModelServer 实际收到的完整请求，含主/子提示、完整工具列表、调用和原工具结果。capture.mjs 只在测试进程关闭 server 时复制请求；snapshot-test.log 为实际捕获的 confirm 单例 1/1。按 chars/4、校准 1 估算，无命令的旧子会话 systemPrompt/toolSchemas 为 38/0，新受限子会话为 38/258；最终正常 confirm 与 auto-review 用例均输出相同估算。这里是离线实际 SDK 请求，不是真实模型质量验收。

independent-review 保存独立适配器 21/21、原生严格指纹撤除的三个失败及活调用末次严格停止撤除的一个失败。strict-negative.log 仅有 command-not-found，明确无效；审查者重跑并读取正文后的 strict-negative-final.log 才是有效反证，meta 文件保存命令、退出码和新旧源码哈希。adapter-final-verified-manifest.json 将两条隔离 import 路径归一化后核对 11 文件；其余字节与根工作区一致。

personal-tests-initial.log 是中间无效一轮：执行尚未结束时作者误启动 setup，依赖目录发生重装，输出四项失败且没有完整收尾；不把它记为通过或据此认定产品回归。安装完成后 isolated-recheck.log 四项通过，最终完整相关集合也通过。初轮 docs 曾超架构页预算五字符、活后代测试清理触发 no-unsafe-finally；修正后最终门禁通过。

真实 Linux 的四项、逐文件归档核对及清理见[独立证据](../25-linux/README.md)。真实模型、IM、拥有者菜单体验、完全访问命令和完整迁移保持待验；本机 HTTP 新路由覆盖认证与菜单调用，未把替身菜单视为操作者产品验收。
