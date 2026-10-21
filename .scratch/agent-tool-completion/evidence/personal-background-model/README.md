# 个人后台真实模型验收

最终组合已在Linux隔离档案通过 `deepseek/deepseek-flash` 验收：四个拥有者轮次、13次真实请求与26条两边界记录。成功运行由[结果](runs/2026-10-21T09-23-09.054Z-78e4f570/result.json)、[四轮工具与事实](runs/2026-10-21T09-23-09.054Z-78e4f570/stages.json)、[源码SHA256](runs/2026-10-21T09-23-09.054Z-78e4f570/source-sha256.json)和[清理证明](runs/2026-10-21T09-23-09.054Z-78e4f570/cleanup.json)持有，16个生产源码与worker哈希均匹配当前根工作区。

`remote-probe.mts` 在 Linux 隔离档案与命令目录运行；`launch.mjs` 从拥有者指定的模型文件选择单模型，只经 `ssh tx` 的 stdin 传递配置与凭据。凭据仅进入远端进程的临时环境变量，不写文件、不放命令行、不打印。重新运行前先将最终源码和probe同步到 `/tmp/ruukoto-personal-04.YNFVXZ7o`：

```sh
RUN_MODEL_CHECK=1 node .scratch/agent-tool-completion/evidence/personal-background-model/launch.mjs /Users/eitrous/.ruukoto/agent/models.json
```

远端固定使用 `/tmp/ruukoto-file-search-linux.kKxATk/repo/node_modules/tsx/dist/loader.mjs`，不安装或改动依赖。launcher 只执行远端现有脚本，随后用 scp 取回本次 `runs/<时间与随机后缀>/`，不上传源码；stdout返回摘要，结果与清理任一失败均以非零状态结束。

实际模型完成：process_start启动本机HTTP服务并从stdout和status取得URL与running；下一拥有者轮查询stdout/stderr与running；process_stop后实际status核实stopped/stopVerified；最后write_file重新取得并释放目录。宿主fetch真实GET并核对随机页面码，这只证明HTTP访问，不构成browser验收；当前Linux Chrome sandbox不可用，没有使用noSandbox降级。

证据保留完整主会话entries、规范输入与实际payload、各轮调用结果、后台Task/记录、目录认领、原scope、源码与制品SHA256、HTTP返回及清理事实。[请求估算](runs/2026-10-21T09-23-09.054Z-78e4f570/request-estimates.json)按UTF-16字符数/4向上取整，首请求toolSchemas4726→5173、systemPrompt137→137；前值来自同次请求移除新增process工具，不是另一次真实改前请求。

成功运行核实服务进程退出、HTTP不可访问、原scope为空、后台与文件claim均释放，临时档案已删除且凭据环境恢复；隔离档案与证据凭据字节扫描通过。首次运行因probe把事务代理带出commit失败，现场保留在 `/tmp/rk-personal-bg-model-FVvDcb`，服务和原scope已停止核实；随后一次模块加载失败没有新请求。失败记录不作通过，最终成功仅对应上述run，生产SHA在两次有模型请求的运行间没有变化。完整汇总见[最终组合](../personal-final/README.md)。
