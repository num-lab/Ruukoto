Status: needs-triage

# 评估既有运行依赖的安全公告与 SDK 升级

2026-10-09 安装 lint 后 npm audit 报 4 项（1 moderate、3 high）。对照原 HEAD 36c55d 的锁文件，涉及的 pi-coding-agent 0.85.1、其 brace-expansion 5.0.9 / undici 8.9.0 与 MCP client 2.0.0 均已存在；本轮未改变任何既有包版本，新 lint 的 brace-expansion 为 5.0.12。

审计建议 pi-coding-agent 升至 1.1.0，属于主版本变更；不能在保持产品/API行为的工程基线任务里自动升级。后续按公告涉及的实际调用路径判断风险，评估锁文件兼容修订和 SDK 升级，保留模型、工具执行、历史与权限回归覆盖。审计完整输出位于 /tmp/ruukoto-baseline-audit.json。
