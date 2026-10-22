# 04 交付双端配置、接管与部署引导

Status: planning

## 目标与边界

交付[规格 R7](../spec.md#r7-管理和部署)及 R1 的人类入口，让拥有者能从现有 MCP 管理位置准备、选择并控制一个电脑目标。依赖 01 的固定路线与 03 的实际接口；本单不做远程视频客户端、云沙箱管理或模型自动安装。

## 方案

1. 复用 Desktop「设置 → MCP → Code/PA」及各产品 CLI/TUI 管理入口。普通服务表单不变；Cua 电脑服务展示目标名称、可用性、归属与未决事实，通过选择和逐步引导配置，内部 ID、修订、请求键由程序管理。
2. Code 同步 control ops、Runtime、Desktop 共用 Host/白名单、TUI/CLI；Personal 同步 settings 查询/保存/发现、停机持锁与 SSH 维护流程。保存不执行业务工具，连接发现只读；显式沙箱目标校验与凭据失败不能降为匿名。个人忙/待核实仍拒绝保存。
3. 在已有会话/管理入口提供绑定、暂停交还、继续、解除、查看原操作与请求核实；迟到响应不覆盖换目标后的页面，关闭界面不取消后台操作。未知状态只显示当前能执行的动作，不提供绕过原占用的“重新连接并继续”。
4. 依据 01 的正式版本给出可执行的 Mac Driver 系统权限、固定网关、TLS/凭据和 Linux 沙箱准备说明；使用无账号测试应用做安装自检。程序与镜像版本固定，依赖缺失说明修复步骤，执行账户与外部生命周期归属明确。示例不把秘密放命令行或日志。
5. 文档同步 `docs/usage.md`、desktop/tui/control/personal-durable 及需要的 deploy 模块；新增安装/验收命令同时更新 README、`docs/development.md`、pre-push-checks。只在新职责确实形成模块时更新架构地图。每端至少覆盖无配置、缺依赖、无授权、目标忙、凭据失效和原操作待核实。

## 进展与交接

- 当前角色与阶段：方案者；复用入口已确认，未设计新页面或修改现行文档。
- 下一角色与动作：01/03 通过后据实际字段和状态实施；UI 使用现有组件及双壳共同宿主。
- 当前内容：`develop`，基点 `419c8384fb8916660b9d84965885fd39b618fe25`；快照和方案审查见[review.md](../review.md)。
- 阻塞与恢复条件：依赖 01/03；系统授权需拥有者在被控桌面完成，若实施中需要实际安装或服务变更，先完成可审阅脚本/配置再按已有授权执行。

## 验收与证据

工程验收待验证。定向检查从 `test/desktop-settings-mcp.test.ts`、`test/desktop-settings-mcp-backend.test.ts`、`test/desktop-personal-settings-pages.test.ts`、`test/personal-settings.test.ts`、`test/personal-mcp-config.test.ts`、`test/personal-mcp-controls.test.ts`、`test/29-cli-entry.test.ts`、`test/33-config-tui.test.ts` 选择；实际触及 SSH 停存启、协议或制品再加对应回归。运行 `npm run check:static`，按实际改动执行双壳/入口构建。

证据放 `evidence/04-configuration.md`。产品验收待拥有者检查两端目标选择、键盘操作、批准/暂停/继续/解除及提示含义；真实系统权限、Linux 桌面和 TLS 自检逐项记录，不以 SSR 或假服务替代。实现审查待执行。

## Comments

2026-10-22：现有 MCP 页面作为入口，拟议功能暂不写进现行操作手册；待实际行为交付再同步。

2026-10-22：分阶段方案独立复核通过，仍等待 01/03 的版本、接口和实际状态，见[审查记录](../review.md)。
