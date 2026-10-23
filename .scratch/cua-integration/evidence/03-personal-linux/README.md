# Personal Cua Linux 停止原语

2026-10-23 在 `ssh tx` 的独立目录 `/tmp/ruukoto-cua-scope-QA1jvV` 验证；Node 24.21.0、Docker 29.5.2。此处只验证 Linux 输入源与沙箱运行代原语，不运行 Cua、桌面或模型，不触碰旧实验容器。来源与构建指纹见 [environment.json](environment.json)。

指纹对应执行时源码；汇总主工作区后仅将三个源码文件中的本篇决定锚点从proposed改为implemented。恢复旧锚点后SHA-256逐项与执行指纹一致，运行逻辑没有变化。

- [scope-check.cjs](scope-check.cjs) 使用真实 user systemd scope，错误 InvocationID 拒绝停止；另一 Node 进程读取持久身份核实停止，结果见 [result.json](result.json) 与 [execution.json](execution.json)。
- [docker-check.cjs](docker-check.cjs) 使用已缓存 `node:24-slim`、`--network none` 与 `--restart no` 创建独立进程夹具。原运行代停止后重新启动，同一完整容器 ID 的 StartedAt 与宿主 PID 出生身份均变化；旧运行代不能冒充新代，磁盘标记保留，新代最后停止，结果见 [docker-result.json](docker-result.json)。三个仅属于本次验证的停止容器均保留。
- [program-check.cjs](program-check.cjs) 用现有 Node 可执行文件作为仅供参数生成的固定制品夹具，核实 Linux 启动参数以 `--embedded mcp` 开头、目标与权限固定、产品秘密不进入环境；见 [program-result.json](program-result.json)，没有执行 Cua。

复验先用 `npx esbuild apps/ruukoto/src/personal-cua-linux.ts --bundle --platform=node --format=cjs --outfile=/tmp/新隔离目录/host.cjs` 生成宿主模块，再把本目录三个检查脚本复制到对应 Linux 目录，依次运行 `node scope-check.cjs`、`node docker-check.cjs` 与 `node program-check.cjs`。Docker 检查需要已缓存 `node:24-slim` 和访问本地 Unix Docker 的权限，脚本不会拉镜像或删除容器。

首次运行暴露两处实际前提：普通账户直接读取 root 进程 PID namespace 返回 EACCES，原额外 namespace 读取使电脑不可用；按固定契约改用 Docker private PidMode、完整容器身份、StartedAt、host boot 与原 PID 出生身份。第二次运行暴露 Docker 停止宽限为 10 秒时客户端也在 10 秒超时，原错误见 [docker-failure-timeout.txt](docker-failure-timeout.txt)，原代见 [docker-original-timeout.json](docker-original-timeout.json)；仅将停止命令预算增至 20 秒，其他查询仍 10 秒。原失败夹具和结果保留，不记为成功。

真实 Cua 制品、正式产品入口的桌面/模型与拥有者观察接受体验仍由后续正式验收完成。
