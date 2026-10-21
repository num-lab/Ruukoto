# 07 Personal 设置专用 SSH 接入与显式停存启

Status: ready-for-agent

## 目标与边界

让 DesktopHost 经 SSH 管理新 durable Personal 配置，落实[Personal 生效规则](../spec.md#personal-接入与生效)及 R1–R4、R6、R9。前置：[01](01-settings-shell.md)、[06](06-personal-settings-api.md)。不把新协议转换成旧聊天快照，不影响既有 Code 连接。

## 方案

1. 扩展 `main/personal-config.ts` 与连接设置向导，单独保存新管理连接的 SSH 别名、远端档案、固定程序定位和受支持生命周期类型；保留旧连接配置归属。程序提供默认与检测后选择，不要求输入内部协议、token 或自由 shell 命令。
2. 复用 `personal-ssh.ts` 的 SSH 参数校验、shell 路径转义、超时、输出限额和子进程回收，在 Node 宿主连接 06 的机器入口；JSON 通过 stdin，不拼为远端命令参数。在线 HTTP 经转发访问原 `control.sock`，每次读取原 `control.token`，只留宿主内存。
3. 校验机器接口版本、产品和档案身份；配置变更与重连更新代次，旧响应不装入。缺新程序/旧协议时提示升级，不回退旧实例。不得仅按 TCP/SSH 建立就显示配置可写。
4. 支持 CLI 脱离后台和仓库 systemd 部署，先核对所选服务实际运行账户、档案与入口；开发受管实例只读。拥有者选择停存启后预检未决，按原生命周期优雅停止、确认退出并取得锁，调用 06 的单项保存，再按原方式启动并读回。在线凭据预检由实际后台只返回指定引用是否可用；离线不得以 SSH shell 或读取 EnvironmentFile 证明原服务环境。CLI 原启动环境不可核实时先只读，给出受支持启动方式的配置步骤。
5. systemd 必须停原监督服务，不能只 HTTP stop。部署切片明确限定系统级 `ruukoto-backend.service`，使用已部署且精确授权的 `/usr/bin/systemctl start/stop ruukoto-backend.service`（`sudo -n`），禁止任意单元、额外参数或任意命令；现有 `ruukoto-service` helper 禁止后台自身且无 start/stop，不能复用它绕过。管理员先配置精确权限及 `SendSIGKILL=no` 的受支持单元，超时保留进程/锁并拒绝保存；GUI 不改 sudoers 或 unit。同步部署说明和最窄配置检查，不改变其他服务停止策略。无前提显示只读与管理员步骤。
6. 未决、停止未核实、锁争用、凭据环境不可用和保存失败均分别报告。停止后若未保存，提供显式恢复原启动动作；保存后启动失败保留已保存事实与恢复入口。
7. 超时/SSH 断线后保留原操作关联，重连查询档案修订与服务/锁状态，不能自动重放保存/停存启或强杀。Electron/MyGo 共用 Host；必要新增宿主方法时同步双 preload 和 MyGo 桥接。更新桌面、个人、部署模块与使用说明。

## 进展与交接

- 2026-10-21 拥有者明确表示「方案已通过」，本单范围与产品取舍已确认；ready-for-agent 表示方案可交实施，实际开工仍须满足本单前置。

- 方案未实施，基点见总规格。下一角色为实施者，先核实 01、06 已交付；08 消费本连接。
- 先以本地 fake SSH + 临时 Linux 档案验证，不向实际生产服务发指令。若检测到不受支持的部署，只读并解释恢复条件，不能假定 SSH shell 的环境等于服务环境。
- 工程与真实 Linux 环境待验收；独立方案审查通过，见[记录](../review.md)，实现未审。

## 验收与证据

- 新增 `test/desktop-personal-settings.test.ts`：旧/新协议拒绝、版本/身份、参数注入、JSON 限额、token 脱敏和轮换、改配置/退出回收、停存启每阶段断线、systemd 自动重启竞态、缺精确授权只读、停止超时无 SIGKILL 且保留锁、原环境未知不伪造通过、保存成功启动失败与 Code 不受影响。新增部署配置的检查须有拒绝默认超时强杀配置的负例。
- `npx tsx --test test/38-desktop-personal.test.ts test/desktop-mygo.test.ts test/personal-settings.test.ts test/desktop-personal-settings.test.ts`；`npm run check:static`。
- 在真实 Linux（可用 `ssh tx`）使用临时目录分别验证 CLI 与仓库 systemd 生命周期，记录服务执行环境、配置版本、断线恢复和无残留自有进程；未跑不能记通过。无 sudo 或 user manager 前提时保留对应缺口。

## Comments

2026-10-21：本单是设置管理接入，不承担完整 Personal 会话迁移。

2026-10-21 方案批准：依据拥有者「方案已通过」解除产品评阅阻塞，状态改为 ready-for-agent；保留前置依赖和待实现/待验收状态，未开始产品实施。
