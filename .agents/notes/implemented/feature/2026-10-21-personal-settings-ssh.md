# Agent Note: Personal 设置通过独立 SSH 连接与原 systemd 生命周期维护

Status: implemented

新配置通过[设置保存与生效](../architecture/2026-10-25-personal-settings-versions.md)在线或离线持锁保存，不再借普通保存停存启；本文旧维护回执的阶段解释、原服务核实与显式恢复约束继续适用。

SSH 传输与桌面维护阶段归属已由下述决定取代，见 [Tailscale HTTPS／WebSocket](../architecture/2026-10-24-personal-tailscale-https.md)；原服务核实、修订与未知效果规则保持。

普通配置保存的停机条件由[设置版本与生效恢复](../architecture/2026-10-25-personal-settings-versions.md)部分取代；本篇保留原身份、认证与旧维护恢复依据。

## 问题

[设置管理提案](../../proposed/feature/2026-10-21-desktop-settings-management.md)要求 Desktop 管理新 durable 档案；[Personal 设置入口](2026-10-21-personal-settings.md)已有认证查询和停机持锁保存，但旧聊天控制器使用不同令牌和协议，也无法证明原服务能安全停止与恢复。SSH shell 的环境不能替代服务环境，HTTP stop 不能停止 systemd 监督者。

## 决定

Electron 与 MyGo 沿既有 request 桥共用 DesktopHost。新管理配置单独保存在 `personal-settings.json`，旧 `personal.json` 继续只用于旧聊天；管理失败不影响 Code。向导选择 SSH 别名、规范远端档案、两个受支持安装位置与生命周期方式。检测先用拒绝缺失档案的 maintenance 核实已有目录身份，再调用 settings 读取，避免 settings 的通用持锁初始化误建错目录；同时核实版本、产品与规范路径。缺失、旧协议与身份变化明确拒绝，不转换为旧聊天快照。

程序检测保留首个候选的结构化错误，仅在所有候选都失败时交给现有界面报告；任一候选成功仍返回成功清单。SSH 中断、档案拒绝与协议错误不能由空清单冒充未安装，不回显原始 stderr 或增加自动重试。

同一管理控制器合并进行中的 `read()`，让设置页切换与连接核实共享一份实际查询；旧页仍按自身轮次丢弃迟到应答。查询成功或失败都释放共享引用，关闭检查仍先执行。合并只适用于同一档案的完整读取，不排队、重发或放开写入，也不合并模型测试、工具发现等不同操作；它们继续沿原互斥与失败策略处理。

机器配置与维护 JSON 分别经固定 `settings`、`maintenance` 子命令的 stdin/stdout 传递，参数不进入远端 shell 命令。沿 OpenSSH 固定参数和 shell 单引号转义，stdin 128 KiB、stdout 256 KiB、有界超时；UTF-8 跨输出块保留。在线设置查询经 Unix socket 转发访问认证 `/settings`，每次重新读取 `control.token`，令牌只在 Node 宿主内存；结构化错误保留请求结果分类并隐藏令牌。配置变化和退出取消本次请求、回收自有 SSH，旧轮次不再继续维护。

`maintenance` 只接受 inspect/stop/start 和 cli/systemd/development，不接受自由命令或单元。CLI 无法证明原启动环境时只读，开发受管实例只读；两者指引先使用受支持系统服务。systemd 只管理系统级 `ruukoto-backend.service`，读取有效属性并核对同账户、固定 Node/bin、`serve --directory` 档案、实际 MainPID 与 `/proc` 身份。显式目录参数优先于环境，避免 EnvironmentFile 改写档案而无法离线核实；从不读取该文件证明凭据。只对固定 `/usr/bin/systemctl start/stop ruukoto-backend.service` 检查并使用 `sudo -n` 精确授权，不放宽禁止后台自身的原服务 helper。

支持的单元要求 `SendSIGKILL=no`、`TimeoutStopFailureMode=terminate`、`KillMode=control-group`、SIGTERM 且没有额外停止脚本。仅禁止最终 SIGKILL 不足以排除 abort 超时分支的 SIGABRT，故同时拒绝该分支。systemctl 对空 ExecStop/ExecStopPost 命令数组不输出属性，只有这两项省略按空处理，任何非空停止脚本仍拒绝；其余必需属性仍须明确匹配。其他服务停止策略保持原样，GUI 不安装 sudoers 或修改单元。停止超时只回收本次客户端，保留后台与锁并拒绝保存；成功后再核实原进程退出、服务 inactive/MainPID=0 与档案锁可得。

Host 只在实际后台在线、生命周期支持、未决检查为空且实际模型凭据可用时接受一次显式停存启；新模型引用由实际后台预检。连接与维护预检均只读取一项配置摘要，未决事项仍完整核对，避免合法大 MCP 列表在停止前超过响应限额。停止后调用原设置单项保存，离线入口在同一档案锁内再次核实身份、修订及未决；完成后按原 systemd 方式启动并读回实际修订。配置成功与模型/MCP 连接测试分开，启动失败保留已保存事实。systemd 启动失败后，原进程退出、MainPID 为零且档案锁可取的 failed 单元仍可显式恢复，不能将 failed 等同于仍有后台占用；启动中、停止中或锁未释放继续拒绝。恢复启动只恢复原服务，不重发保存，也不要求先消除只有原后台才能处理的未决事项。

每次写操作先在私有本机 journal 保存原档案、操作身份、原修订、请求摘要和阶段，不保存配置草稿、令牌或服务环境。重开相同连接读取原记录，pending 时不允许改掉原连接；停、存、启任一断线都只查询原档案修订与服务/锁状态，不重放或强杀。已取得保存回执仍报告已保存；没有回执且已尝试保存保持待核实，内部错误不能证明未保存。仅明确的写前拒绝报告未保存；托管技能修订冲突在任何变更前拒绝，保留比较草稿及显式恢复原服务的入口，不归入丢答。拥有者比较当前配置与原草稿后显式结束维护；记录清除失败不开放下一次写入。

## 既有笔记审计

按 Personal、SSH、生命周期与 systemd 检索 active notes；[设置管理提案](../../proposed/feature/2026-10-21-desktop-settings-management.md)、[设置容器](2026-10-21-desktop-settings-shell.md)、[Personal 设置入口](2026-10-21-personal-settings.md)、[个人本机管理](../architecture/2026-10-17-personal-local-management.md)与[桌面客户端](../../proposed/architecture/2026-10-15-desktop-client.md)部分重叠，分别继续持有规划、表单导航、配置锁、本机交互与旧聊天。本篇新增 SSH 维护归属；没有完全吸收、需删除或归档的笔记。

## 备选方案

- 复用旧聊天控制器：可以少一个连接对象，但新协议与令牌来源不同，无法证明新档案的配置身份，因此保留独立管理连接。
- HTTP stop 后直接保存：无需额外服务权限，但 systemd 可能自动重启并抢锁，因此必须停止原监督服务。
- 复制 SSH shell 环境或读取 EnvironmentFile：容易启动一个程序，却不能证明原服务的环境且扩大秘密读取，因此 CLI 未核实保持只读，systemd 只按原服务恢复。
- 保存完整草稿到本机再自动重试：恢复方便，但远端端点可能含秘密，后端也没有保存幂等键，因此只保存摘要与关联，丢答人工比较、不重发。
- 读取期间禁止切页：可以避免重复读取，但会让纯查询阻塞导航；同一档案共享进行中的读取即可，写入继续沿原互斥。

## 后果

新管理连接与原 Code、旧 Personal 聊天独立，保留档案锁、条件修订、未决占用和实际凭据环境。代价是管理员先部署精确权限与单元；未知 CLI 环境暂只能读取。自动化使用 fake SSH、真实 HTTP socket、临时档案与受控 systemctl 客户端覆盖拒绝与断线；这些不证明实际生产服务可维护。真实 Linux、双外壳与主观体验缺口由工单验收记录持有，后续 Personal 管理页面消费同一 Host 接口。
