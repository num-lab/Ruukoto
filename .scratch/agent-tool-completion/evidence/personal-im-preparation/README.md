# QQ／Telegram 隔离入口准备

已在 `tx` 创建本次空档案 `/tmp/rk-personal-im-prep-79x71a/profile`，资料根为同级 `files/`，Linux 命令目录为同级 `commands/`。只保存 `deepseek/deepseek-flash` 的单模型配置、凭据环境变量名、资料根与命令目录；没有传输或复制模型凭据，没有 QQ／Telegram 配置，没有启动后台或连接真实账号。[准备事实](prepared.json)记录时间、文件权限、源码 SHA 与确切路径；[准备脚本](prepare.mjs)可从指定 models.json 重新创建另一个新档案，每次均不复用旧档案。

本机与 `tx` 的当前进程环境均未发现 QQ／Telegram／OneBot／NapCat 相关变量名，两个默认 durable 档案路径也不存在。这只覆盖当前 shell 和默认路径；没有搜索或读取其他日常档案、systemd 凭据或真实账号配置。因此真实 IM 验收仍缺专用账号、配对消息和凭据前提。

打开准备好的入口：

```sh
ssh -t tx
cd /tmp/ruukoto-personal-04.YNFVXZ7o
export RUUKOTO_PERSONAL_DIR=/tmp/rk-personal-im-prep-79x71a/profile
node --import /tmp/ruukoto-file-search-linux.kKxATk/repo/node_modules/tsx/dist/loader.mjs apps/ruukoto/src/personal-entry.ts
```

先由拥有者在这个远端 shell 提供 `PERSONAL_IM_ACCEPTANCE_MODEL_KEY` 的环境值；平台配对时另提供 `PERSONAL_IM_ACCEPTANCE_TELEGRAM_TOKEN` 或 `PERSONAL_IM_ACCEPTANCE_ONEBOT_TOKEN`。值不写入档案、证据或命令历史。打开菜单本身不会配置平台，也不会自动启动后台；本次已用真实PTY打开向导，进入「配置能力」确认Telegram和QQ配置项可见后返回退出；未提供凭据或选择配对，见[菜单核实](menu-smoke.json)。

Telegram 前提是专用测试 bot、另一真实拥有者私聊账号、可访问的 Telegram Bot API，以及该测试 bot 的其他接收后台已停止。选择「配置能力（后台须停止）」→「配置 Telegram（后台须停止）」→「配对并启用专用 bot」，API 地址默认 `https://api.telegram.org`，凭据变量名填 `PERSONAL_IM_ACCEPTANCE_TELEGRAM_TOKEN`。向导实际核实 bot，确认接管并过滤旧积压后，按屏幕随机短语向该 bot 私聊；3 分钟内回到向导，候选出现后在 60 秒内选择本人。配置只保存变量名、指纹、原账号、拥有者与随机代次；完成后重新发送验收消息，配对边界及以前消息不执行。

QQ 前提是专用测试 QQ 账号、在线 NapCat／OneBot v11 正向 WebSocket、另一个互为好友的拥有者账号，以及该测试 QQ 账号的其他后台已停止。选择「配置能力（后台须停止）」→「配置 QQ（后台须停止）」→「配对并启用专用测试账号」，输入实际回环 `ws://127.0.0.1:端口` 或无凭据的 WSS 地址，凭据变量名填 `PERSONAL_IM_ACCEPTANCE_ONEBOT_TOKEN`。向导核实登录账号后，用拥有者好友直接发送随机短语，3 分钟内完成选择；群聊、群临时会话与自己发给自己的消息不接纳。配对边界同秒及以前消息不执行，启动后发送新消息；OneBot 没有离线补拉，断线缺口不能记为已受理。

仅在专用测试平台配对完成后，从「实例状态与启停」选择「启动个人后台」，再用「查看 Telegram 收发」或「查看 QQ 收发」核实在线与本次新消息。两平台在原私聊发送 `/帮助`、`/问题`、`/后台` 均进入宿主管理菜单；选择须回复已送达的原菜单。问题逐题选择、多选／Skip／自由回答，并沿原核对菜单确认；后台从原列表选择对象，读 stdout／stderr、停止并刷新核实。回复普通模型回答或跨平台回复不能替代原菜单。需要完全访问时从新原入口的 `/权限` 菜单明确选择，只影响之后的新输入。

也可用同一远端 shell 前台托管，便于保留本次终端证据：

```sh
node --import /tmp/ruukoto-file-search-linux.kKxATk/repo/node_modules/tsx/dist/loader.mjs apps/ruukoto/src/personal-entry.ts serve
```

前台与菜单启动二选一，档案锁禁止并行接管。菜单退出不停止独立后台；验收结束从「实例状态与启停」选择「停止个人后台」，等待原锁释放，或给前台进程发送正常终端中断。不要删除 socket、控制令牌、待核实文件或旧会话来接管。准备目录本次保留供专用账号就绪后使用，未声称模型、IM 收发、原菜单或浏览器验收通过。

操作依据为本次源码 `personal-cli.ts` 的 `runPersonalCli`／`configurePersonalTelegram`、`personal-qq-cli.ts` 的 `configurePersonalQq` 和 `personal-telegram-api.ts` 的 `telegramOffset`。本次只创建空配置并核实向导菜单，没有调用个人Harness、模型provider、Telegram API或OneBotClient。
