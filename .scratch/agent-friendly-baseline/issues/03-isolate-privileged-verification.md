Status: needs-triage

# 让特权验收在一次性 Linux 环境安全复跑

旧 smoke-09/10 会覆盖生产 helper、策略和 sudoers并保留；full-access 依赖既有固定 UID 与 sudo/systemd 包装。本轮将原始源码归档为不可执行文件。后续提供独立演练资源、环境门禁、准备与完整清理契约，验证生产部署和配置不受影响后才开放运行入口。
