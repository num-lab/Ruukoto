# Agent Note: 个人认证令牌完整写入后发布

Status: implemented

## 问题

个人后台逐启动轮换 control.token，直接 writeFileSync 会先创建或截断文件。跨进程客户端可以在写入完成前读取空值，得到 control_token_invalid；重启与信号集成已出现该反例。测试的目录清理又先于后台停止，失败后可能跳过其他清理并留下进程和监听。

## 决定

持原档案锁，先沿现有 readPersonalToken 校验拒绝坏旧令牌，再把新值以 0600 写入同目录 control.token.tmp，写完后 rename 到 control.token。沿已有配置临时文件惯例，档案允许列表接纳普通 control.token.tmp；残留文件在取锁后收紧权限并重写，认证从不读取它。首次发布前仍可报告 control_unavailable，轮换读取只见完整旧值或新值。

写入和替换失败沿既有 control_start_failed 释放锁并拒绝启动，不启动监听，不将认证文件损坏视为可重试。成功后的档案格式和 HTTP 协议保持；rename 只保证文件发布对并发读者完整，不宣称与 SQLite 或断电持久化原子。

入口集成的清理只在本测试文件内汇总，依次停止自有子进程、关闭模型替身、删除临时目录；每项异常收集后继续执行其余清理，最后抛 AggregateError。真实信号、锁释放和认证断言继续保留。

## 既有笔记审计

[个人本机管理](../architecture/2026-10-17-personal-local-management.md)部分重叠：保持独占、逐启动轮换、坏令牌拒绝和私有权限，补足发布方式。[个人 durable 基础](../architecture/2026-10-17-personal-durable-foundation.md)的旧档案拒绝保持，只允许本次原子发布所需的普通临时文件。按 control.token、令牌与原子发布检索，未发现同题提案。

## 备选方案

- 客户端对 control_token_invalid 自动重试可以绕过短暂空窗；也会掩盖真实损坏，不采用。
- 仅让测试等待 socket 出现能避免初次读取太早；不能保护重启时仍持旧路径的真实读者，不采用。
- 新增通用原子写入库可统一所有配置；仓库已有本地 tmp/rename 模式，本次不增加跨模块抽象或依赖。

## 后果

成功发布仍只有原 control.token。中断时可能留下普通临时文件，下次持锁启动可重写；坏旧令牌继续要求保留档案并检查，不借残留 tmp 自动修复。受控初次/轮换读取、失败写入、清理与平台证据见[修复工单](../../../../.scratch/ci/issues/04-publish-personal-token-atomically.md)。
