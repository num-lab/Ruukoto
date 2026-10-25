# Scheduled 真实模型验收

拥有者于 2026-10-26 明确提供 `/Users/eitrous/.ruukoto-code/agent/models.json` 用于验收；本轮只读取该文件，原样复制至新的私有 agentDir，没有复制旧 auth.json、settings、历史或其他凭据，也没有继承凭据环境变量。源摘要为 `bf2bfef9ea4a0a3d8cfbaa0db5f574b1092fe99a5e7ad55ebff3c5e4be0e742f`，结束后复核不变。

Node 24.15.0、macOS 下使用真实 `magpie/auto/deepseek-v4.1-flash`，effort=off、permission=confirm；通过临时模块链接使用主检出的实际 Runtime 与产品装配。主检出基于 HEAD `493b91c4` 加未提交实现，运行后记录的关键源码摘要见 [source-manifest.json](source-manifest.json)，不把这些后记摘要称作启动时锁定。复用入口为 `test/code-scheduler-model-acceptance.test.ts`，默认离线 skip，显式 `RUN_MODEL_CHECK=1` 才调用模型。

## 结果

初测通过，实际任务约 15.5 秒、四次真实模型请求，见 [run-initial.log](run-initial.log) 与 [result-initial.json](result-initial.json)。后端冻结后使用同一用例独立复验，结果与启动前源码摘要见 [run-frozen.log](run-frozen.log)、[result-frozen.json](result-frozen.json)、[frozen-source-manifest.json](frozen-source-manifest.json)；冻结轮另证明统一关闭逻辑。每轮上限为六次请求、三分钟，没有加跑第二条完全访问计划。

- 到期接纳建立独立会话，实际 cwd 为临时工作区，计划标题、说明、模型、权限和 effort 固定；活动运行的普通 submit 被宿主拒绝。
- 第一轮真实调用一次 ask_user，题目持久化后结束；运行保持开放。专用问题入口回答“允许写入”，续接仍属于原运行并沿原模型与 confirm 权限。
- 真实模型调用一次 request_file_access；仅在路径、operation=write、固定内容和原因全部精确匹配时批准唯一审批，批准前目标不存在，完成后工作区只含这一个 marker 文件。
- 两个 Task 和整项运行均 completed，工具无错误或未知效果，目录占用归零；会话 JSONL 含题目和写入参数，四份真实请求快照包含原输入及回答。证据只保留快照与 marker 的 SHA-256、工具名、估算和布尔断言，不保存请求原文或凭据。
- 结束时正常停止测试 Runtime，删除整个临时 agentDir；临时凭据副本已清除，源模型文件不变。已用源文件中的凭据字段扫描本目录文本，未发现凭据正文。

普通 write 在工作区内不必然要求审批，因此本轮使用真实结构化 request_file_access 验证 confirm 的逐次批准。验收仅向编码工具集合提供该受精确参数保护的工具，ask_user 沿真实宿主工具；异常工具意图会持久取消，不允许扩大测试范围。

临时外部测试目录最初缺少 ESM 声明，导致 typebox 在导入时失败，见 [harness-before-esm.log](harness-before-esm.log)；当时尚未读取模型文件或发送模型请求。补临时 package.json 的 type=module 后才开始初测。初测后将凭据副本写入移入既有 try/finally，覆盖写入失败清理；冻结轮使用提交的最终用例。

## 未覆盖

本轮不证明真实桌面、IM、机器休眠、定时电脑控制、所有提供方或完全访问行为。来源失效、未知恢复和停止竞态由 Linux 冻结增量另验；真实模型只证明本用例覆盖的提问、回答、精确审批与正常收尾链。
