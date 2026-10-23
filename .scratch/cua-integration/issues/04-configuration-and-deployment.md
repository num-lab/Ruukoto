# 04 交付 Cua 配置与人工恢复入口

Status: ready-for-agent

## 目标与边界

实现[规格R7](../spec.md#r7-管理与部署)，沿现有 MCP 设置与管理入口完成双端启用、暂停、恢复；不新造桌面视频界面或沙箱管理平台。

## 方案

1. Code的MCP设置增加“本机Cua Driver”，Personal增加“Linux桌面沙箱”。从已安装程序和既有沙箱选择，显示权限/连接检查结果；内部命令与代次由程序生成，不让用户编辑JSON或填请求键。
2. 沿03的配置/控制接口接 TUI/CLI、Desktop code-mcp 与 Personal settings/controls。保存前核未决动作及配置版本，停用立即拒绝新调用；关闭设置窗不代表停止后台动作。
3. 恢复入口逐步显示原未知动作、执行停止核实、人工检查、开始只读恢复、新截图接受。Linux需要整沙箱停止时明确告知未保存应用状态会丢失并由拥有者选择；不伪造“一键重试旧动作”。
4. docs/usage.md给官方安装链接与固定版本、Mac direct宿主权限、Linux本地运行前提、正常关闭/故障处理；不要求额外一台Mac，不安装TLS网关。工具与命令有变才同步README、development和pre-push-checks。
5. 按真实改动同步desktop、tui/control与personal-durable模块。无Cua环境时普通设置/聊天仍可使用。

## 进展与交接

- 当前角色与阶段：方案独审已通过；03工程实现与独审完成，配置和控制接口可接线。
- 下一角色与动作：实施者沿现有组件和控制面接入，不增通用进程配置编辑器。
- 当前内容：03的具名配置、版本和控制字段见[当前交接](03-target-lifecycle.md#进展与交接)，实施与离线结果见[工程证据](../evidence/03-offline.md)。Linux启动固定--embedded，不能接共享daemon；Code接受观察回传observation_id，Personal回传observation，均由界面保存，不让用户填内部身份。
- 必须补齐：将Code status的artifactIds和Personal detail.recoveryImages呈现为实际可查看的新截图，并把接受动作绑定该观察；旧图、重观察失败或迟到的旧接受不能通过。03只提供引用/路径，未声称人工体验通过。
- 阻塞与恢复条件：仍缺正式安装/选择与截图查看界面；无Cua环境时保留普通聊天与HTTP设置，不能把03离线成功当成正常入口已可用。

## 验收与证据

工程待实施：定向desktop-settings-mcp、backend、personal-settings与controls用例，覆盖缺安装/权限、保存失败、未决配置拒绝和恢复选择失效。产品待验收：拥有者从正常入口完成两端配置与一次暂停/继续，05复用该结果。只做实际受影响的构建与静态检查，不因新增选项全仓测试。

## Comments

2026-10-23：以官方程序与现有产品设置为入口，去掉自建HTTPS服务部署、认领凭据与全局桌面锁管理。
