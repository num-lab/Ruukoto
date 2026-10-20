# A11执行中客户端退出：独立协议补证

2026-10-18，macOS当前Node24.15.0。结论：本探针恰好补齐“原真人退出时未捕获执行中窗口”的协议证据；不改称真人曾完成该窗口，也不代替真实IM、TTY交互或全部A11。未写根仓库，未修改产品等待，没有使用真实模型/IM或凭据。

从当前`test/personal-cli.test.ts:243`单例在/tmp派生，保留正式`launchPersonalServer`、真实Node客户端、原程序生成输入键、后台锁/socket、停机重开与历史读取。唯一业务时序改为MockModelServer responder gate阻止回答：客户端提交admission后exit0，确认实际请求已收到且原`/input`仍为placed、没有answer，finally放行后等待同一输入done。重复启动拒绝且socket inode不变；停原后台后再次正式启动，同一原输入仍done、answer与历史一致、模型调用总数仍1。

亲跑命令：`node --import tsx --test --test-name-pattern='独立A11：真实客户端在模型执行中退出' /tmp/ruukoto39-a11-inflight-cli/proof.test.ts`，cwd为根工作区。1/1通过、0跳过，Node报告约4.34秒，进程exit0。精确耗时以run.log为准。loopback模型请求只有1次。

fixture原有清理停止后台、等待重新取得原profile锁、关闭MockModelServer并删本次临时目录；gate在局部与外层finally释放，断言失败不会让清理等待未放行回答。没有向其它后台发信号。

证据：`source.json`记录原test SHA、派生SHA、Node与cwd；`fixture.delta.diff`只列原单例与派生单例的差异；`proof.test.ts`保留可重跑完整夹具，顶层相对import仅为/tmp运行改为根绝对路径；`facts.json`保存实际exit/placed/done/重开/调用数；`run.log`为亲跑原始输出。
