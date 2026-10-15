# 05 Driver 父级注入测试夹具独立补充审查

requirements_audit 只在独立临时副本运行，本附录补充第27个修复文件，不改写已归档的60项输入、25文件审查、来源生产补丁或原完整检查结果。

原 test/125-agent-wait-resource.test.ts:181–211 两条隔离 Driver 消费时机：手工创建无 work/subagent 的普通 Task，并替换 parentInjection 与 parentInjectionAccepted，但遗漏新增的真实 Runtime parentInjectionRecheck。Driver:353–355 按真实来源资格拒绝该夹具符合安全合同，不能通过生产例外放行。

审查 patch a2f52998b80fbf5068b6498198e75132b8afeade71b91a46e882e2cfab37c589，仅在同层补齐 recheck mock，逐次核对会话、结果 ID 列表和消息 ID 列表，返回 null，并要求至少一次复核；真实 Runtime 来源正负边界仍由 test/subagent-result-source-boundaries.test.ts 的8例持有。新增 provider 请求必须包含已记录子结果 sentinel，且成功/失败均恰有一次实际请求，防止失败分支因发送前拒绝而假绿；原成功消费1次、失败消费0次及任务状态断言全部保留，accepted 另核空消息列表。该层次同步成立，无生产放宽。

独立执行同一命令：`npx tsx --test --test-name-pattern='^父级注入 ' test/125-agent-wait-resource.test.ts`，工作目录 `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/rk05-target-independent-sjdtgrlt`。先应用候选：2/2、0跳过、exit0、1773.260916ms；再 reverse 候选复现旧夹具：1通过1失败、0跳过、exit1、1001.08725ms，成功分支实际消费0而期望1，旧失败分支仍通过；finally 重新应用候选并核对最终文件 hash 为4153139463ad21457133fa8d06b850f6af8dd228c0ad5cb9310b4a4da4173bef。未执行模型或 native 场景。

日志分别为 `/tmp/05-independent-parent-injection-fixture-before.log` 与 `/tmp/05-independent-parent-injection-fixture.log`，精确文件与三个生产文件摘要见 `/tmp/05-parent-injection-independent-inputs.json`。这两条最窄绿不替代完整检查；当前 Linux 原完整 runner 沿修补前冻结输入继续，原退出事实需单列。
