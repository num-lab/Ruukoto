# ruukoto 工具工作进程镜像

请求确认模式下，任务的编码工具（read/edit/write/bash）在该镜像启动的容器内执行。
容器配置（固定，不允许任务修改）由 `src/agent/execution/launchers.ts` 的
`createContainerLauncher` 给出：非 root（uid/gid 1000）、`--cap-drop ALL`、
`no-new-privileges`、只读基础文件系统、可写 tmpfs `/tmp`、默认无网络，
只挂载拥有者授权的工作区与任务级显式授予路径（均按宿主原路径挂载）。

构建（可信身份执行；容器按任务启动，任务结束回收）：

```bash
bash deploy/worker-image/build.sh   # 产物：ruukoto-worker:<pi 版本> 与 :latest
```

镜像版本随 pi 发布版固定；升级 pi 时更新 tag 并重建。工作区访问按任务挂载，
容器内的系统工具与临时文件属于基础执行环境，不构成对宿主的任何承诺。

工具链：node 24 + bash + coreutils（slim 基础镜像）。git 未装入——本仓库
开发机的网络无法访问 apt 源；在目标服务器构建时恢复 Dockerfile 顶部注释
中的 apt 安装步骤即可（git 是编码检查的常用工具，建议恢复）。
