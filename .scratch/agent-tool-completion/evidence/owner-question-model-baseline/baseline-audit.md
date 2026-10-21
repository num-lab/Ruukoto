# Coding 提问改动前的实际请求基线

源码由 git archive 导出固定 HEAD `88a0e2a9eb28886b4e9c9a506d3eb115b511234a`。副本使用独立 node_modules 目录，8个 @ruukoto 工作区链接全部指向副本中的包；外部依赖复用共享检出的已安装依赖。runtime、agent、session-factory及产品装配文件按字节核对了对应Git对象，environment.json记录哈希和链接目标；实际Runtime与Driver模块解析路径也在summary.json中。没有构建worker，也没有调用工具。

使用与最终验收同一份显式配置、同一 provider/model（agentrouter/deepseek-v4-flash），新建普通Coding完全访问会话，输入“只回复BASELINE，不调用工具”，发出一次真实模型请求。环境为darwin/arm64、Node v24.15.0。基线快照没有ask_user，共31个工具；实际任务被模型服务以400拒绝，因为基线list_files的可选参数schema没有required数组，被该服务解读为null。这里如实记录failed，不记基线功能验收通过，也未修改基线来绕过失败。

实际请求快照及selection记录中的估算为：改动前systemPrompt=1506、toolSchemas=11022；最终版本systemPrompt=1506、toolSchemas=11463，增量分别为0、441。系统提示仅临时工作目录不同；工具新增只有ask_user，其他5个工具只增加required:[]，没有其他工具差异。comparison.json保存这些逐项核实结果，并引用两份快照的SHA-256。这是实际发送前快照的本地估算对比，不表示模型服务接受了HEAD基线请求。

Runtime已经停止，带凭据的新隔离档案已经清理。证据目录未导出模型配置，所有文件按显式配置中的实际API key作精确匹配检查，未发现泄漏。
