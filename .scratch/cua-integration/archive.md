# Cua 历史材料与回滚

2026-10-23 按拥有者要求，先保存并核实材料，再将分支从 `ab725aedc228f3c8330d93bee6c26fe5703f71c0` 回滚到 `e8479aa13abb2927e98c11abe51179dcd2ec1eea` 的父提交 `14ee3d007bac3bb99cf104ad55c8aeccb7aa50a4`。回滚完成后、写新方案之前，Git 工作区已确认干净。

## 外部备份

本机备份根目录：`/Users/eitrous/Developer/ruukoto-backups/cua-before-rollback-20261023-130957`。[恢复说明](/Users/eitrous/Developer/ruukoto-backups/cua-before-rollback-20261023-130957/README.md)、[校验结果](/Users/eitrous/Developer/ruukoto-backups/cua-before-rollback-20261023-130957/VERIFIED.json)、[逐项清单](/Users/eitrous/Developer/ruukoto-backups/cua-before-rollback-20261023-130957/manifest.json)、[回滚结果](/Users/eitrous/Developer/ruukoto-backups/cua-before-rollback-20261023-130957/rollback-result.json)。这是一份本机私有归档，不是仓库内的可移植测试夹具；其他机器接手先取得备份，不因路径不存在而重跑桌面实验。

保存 48,185 个文件/符号链接，文件内容共 1,663,861,596 bytes。工作区快照逐文件比对 SHA-256/链接目标；Git bundle 经 verify；回滚前再次核对 HEAD、状态和补丁未变化。备份包括全部可达 Git 历史、未提交修改、未跟踪文件、完整 Cua 实验目录及本机相关 /tmp 材料。临时副本的 node_modules/.git 共10处缓存未复制，精确范围见 metadata.json，主仓库历史已由 repository.bundle 保存。原 /tmp 目录未删除。

## 证据入口及适用范围

以下路径都相对于备份根目录。

| 路径 | 内容 | 可复用范围 |
| --- | --- | --- |
| workspace/.scratch/cua-integration/evidence/01-mac.md 与 01-mac/ | 官方 app、权限、工具与旧桥接结果 | 固定制品与权限事实；不代表新产品接线 |
| workspace/.scratch/cua-integration/evidence/01-linux.md 与 01-linux/ | Linux 制品、镜像、操作、连接缩放及失败材料 | 沙箱环境和上下游语义 |
| workspace/.scratch/cua-integration/evidence/01-owned-execution.md 与同名目录 | direct、停止、持久未知与人工恢复实验 | 同一执行机制的停止/恢复依据 |
| workspace/.scratch/cua-integration/evidence/01-owned-execution/continuation-20261023/ | Mac边界与Linux最终收尾、原失败、独立审查 | 有限结果，不把已通过部分扩大成产品通过 |
| workspace/.scratch/cua-integration/evidence/official-docs-check-20261023.md | 官方指导与固定源码对照 | 调查来源，按当前版本核对适用性 |
| workspace/packages/agent/src/mcp/transport.ts 及 test/、temporary/ 中 cua06 材料 | 回滚前未提交的共享 HTTP 修复与验证 | 可单独取回评审；不混入本次新方案 |
| workspace/.scratch/cua-integration/spec.md、executor-protocol.md、issues/、probes/ | 被撤回的完整方案与探针 | 历史参考，不指导新实施 |

旧结果未知、失败、原请求与截图均保持原文件；本轮没有改判历史结果。新规格不继承已删除的全局独占验收。恢复时先在独立目录检出 bundle 的原 HEAD，再取需要的 workspace 文件，避免覆盖现有工作。

## 未做的操作

未上传备份、未推送或强推分支、未重启 Mac/Linux 实验、未改远端容器或应用现场。回滚同时撤下了旧 Cua 探针与未提交 HTTP 修复；相关缺陷并不因回滚而消失。后续如修通用 HTTP，应从归档复用问题和证据，作为独立维护改动验收。
