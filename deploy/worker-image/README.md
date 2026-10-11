# ruukoto 工具工作进程镜像

请求确认模式下，任务的编码工具（read/edit/write/bash）在该镜像启动的容器内执行。容器配置（固定，不允许任务修改）由 `packages/agent/src/execution/launchers.ts` 的`createContainerLauncher` 给出：非 root（uid/gid 1000）、`--cap-drop ALL`、`no-new-privileges`、只读基础文件系统、可写 tmpfs `/tmp`、默认无网络，只挂载拥有者授权的工作区与任务级显式授予路径（均按宿主原路径挂载）。

构建（可信身份执行；容器按任务启动，任务结束回收）：

```bash
npm run build:worker-image   # 产物：ruukoto-worker:<pi 版本> 与 :latest
```

镜像版本随 pi 发布版固定；升级 pi 时更新 tag 并重建。工作区访问按任务挂载，容器内的系统工具与临时文件属于基础执行环境，不构成对宿主的任何承诺。

Dockerfile 与宿主共用 `npm run build`，生成 `worker/worker.mjs`；打包器版本由根锁文件固定。

工具链：node 24 + bash + coreutils + git。Dockerfile 的运行阶段通过 apt安装 git 与 ca-certificates，容器中的检查、worktree 创建及改动汇总可直接使用 git。
