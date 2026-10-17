# 工单 16 独立实现审查

审查者 execution_design，工作区只读，基点 HEAD 3f38ad97abcf533d0ab26e256f42a1cd90dbfaff。最终实现无未解决阻断。源码与审查文件哈希见 reviewed-files.sha256；本目录保留最终原始 Linux 日志及实际运行的 helper/test、两份反证 helper。测试为真实进程，systemctl/systemd-run 为隔离命令桩，没有部署正式 helper。

直接读取总规格、工单 16、决策笔记、实际 helper/types/tests/docs 变动和三个旧/新调用方。首版 PGID===PID 限制造成实际 sudo 非首领无法使用，审查中经技术复核去除；最终允许同组监护，只观察原组，不从持久身份发杀进程信号。

本机五文件调用方 119/119 通过，零跳过。该批在当前 service-helper.ts 哈希上执行；之后只删除 Linux helper 的首领限制并调整 Linux 夹具，调用方逻辑未变。本机原始完整日志未另存，仅执行结果来自审查工具响应。notes/docs/diff 在最终文档修订后再次通过，工具响应未伪称成本目录原始日志。

Linux 6.8.0-117-generic / Node 24.21.0：最终 root 13/13、非 root 13/13，均零失败/跳过；两者是相同的 11 顶层用例加 2 子用例，不能累加为 26 个唯一场景。root 使用 /opt 专属夹具，保留 root 路径信任核实与检查 UID/GID 降权；非 root 夹具按既有代码略过 root 属主校验。

反证只改独立副本：final-no-group 删除 launcherProcessState 原组观察一行，所选原 helper 已死而后代仍活用例 0 通过/1 预期失败，实际 true、预期 false。final-no-stop-marker 删除启动前停止标记检查一行，所选 mkdir/claim 窗口用例 0 通过/1 预期失败，实际退出 0、预期 64。均在 root 环境运行，原始错误日志保留。

未重跑全仓 check、setup/build、真实 systemd、已安装 helper/sudoers、模型或 IM；未声称 durable/子工具生命周期完成。协议对主动脱组的通用后代不提供证明，顽固组或组号复用可以保守阻塞。远端清理与残留进程扫描结果另见 cleanup.log。

两份失败原始日志以 `.log.gz` 封装，解压后逐字节保持 Node 输出（包括失败断言中的空白行），避免文本 diff 的尾空白门禁。
