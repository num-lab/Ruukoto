# 工单39隔离业务准备

oracle-4c24g，Ubuntu专用验收范围。两项业务均保留运行供根Agent继续组合验收；本Agent没有写live-profile、读取既有model-source/token或操作现有QQ/TG后台/隧道。没有修改仓库依赖、产品源码或sudoers。

## MCP HTTPS业务

端点 `https://127.0.0.1:19439/mcp`，只绑定127.0.0.1，官方@modelcontextprotocol/server与node均2.0.0，独立package-lock；zod4.6.7。实际握手协商协议2025-11-25，不把SDK支持版本混作本次协商版本。用法依据官方HTTP文档 https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html 与包说明 https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages 。

- CA公钥：`/home/ubuntu/.local/ruukoto39/test-business/mcp/tls/ca.crt`。在连接端Node进程启动前通过NODE_EXTRA_CA_CERTS注入；没有修改系统信任或关闭TLS验证。
- 私有Bearer引用：`/home/ubuntu/.local/ruukoto39/test-business/mcp/private/bearer-token`，ubuntu拥有0600、nlink1；值不在本记录中。
- 工具：`records_list`仅查询，可选marker；`record_add`必须marker，每次追加且只插一行，重复调用新增行。
- 真实库：`/home/ubuntu/.local/ruukoto39/test-business/mcp/data/records.sqlite`；准备快照在test-business/evidence/records-preparation.sqlite。
- 启动身份：PID3436943、Linux startTicks409218107；server.mjs与pid.json记录身份。后台仅继承显式PATH/HOME，从自己新建私有文件读MCP凭据。

真实反例：不注入CA时UNABLE_TO_VERIFY_LEAF_SIGNATURE；有CA但无token/错token分别401，库计数保持0。正确凭据经当前仓库connectMcpEndpoint真实发现两工具、record_add计数0→1，records_list读回相同marker且该marker仅一行。准备唯一行标记为PREFLIGHT39_a462db09d3d3468bacac2bf5a6a55fc1，后续用新marker区分业务。额外discoverPersonalMcp与严格parsePersonalMcp已通过，未保存任何个人档案。

## 原helper与测试systemd服务

`ruukoto39-test.service`已启动，初始count=1，Restart=no、PrivateNetwork=yes、NoNewPrivileges=yes，无网络/业务凭据；启动程序运行ubuntu，状态`/var/lib/ruukoto39/test-service`。没有启用开机启动，没有自行执行restart。

配置：helper `/usr/local/libexec/ruukoto39/ruukoto-service`；policy `/etc/ruukoto/services.json`；sudo `/usr/bin/sudo`。原helper固定policy与ops路径，根Agent核对后授权在原固定路径全未占用的前提下新建，仅白名单ruukoto39-test.service/restart。原helper安装字节与仓库完全相同，SHA256=3f645f2ef05ff626f1def39ef1b0065f893385f96bdb0142c14aad864fb6433f；实际sudo inspect通过。既有/usr/local/bin/node为root拥有，未新增或改写Node解释器。

新建根路径清单由`test-business/service/install-summary.json`记录：`/usr/local/libexec`（原先不存在）、其下ruukoto39专用目录/helper/启动程序；`/etc/ruukoto/services.json`与新父目录；`/var/lib/ruukoto/service-ops`与新父目录；`/var/lib/ruukoto39/test-service`与新父目录；`/etc/systemd/system/ruukoto39-test.service`。没有覆盖既有配置。第一次安装前置检查因/usr/local/libexec不存在而停止，未执行任何sudo安装；补登记新父目录后完成安装，失败原文仍在工具记录。

## 保留与回收边界

先完成根Agent的验收与证据归档，再停止这两个专用业务。MCP停止前核对/proc/3436943/stat的startTicks与cmdline均匹配pid.json后，仅向此进程/自建进程组发送TERM；不要扫描或停止其他Node进程。服务仅停止精确ruukoto39-test.service，并核实MainPID退出。不要停止个人后台或隧道。

删除前核对安装文件hash仍匹配自建清单；保留业务SQLite、启动计数和helper操作回执的最终快照。根路径只处理本次自建文件与空目录；service-ops若有未核实原执行/回执先保留，不递归删除全目录；新增父目录只用rmdir，在有其他内容时保留。MCP私有token、CA私钥、叶私钥排除入库归档，停止并确认不再使用后再清理。新生成CA只信任此测试服务，不能移作生产CA。

## 证据

本机 `/tmp/ruukoto39-business-preparation.json`；远端 `/home/ubuntu/.local/ruukoto39/test-business/evidence/preparation-summary.json`。包含创建清单、包锁、工具定义、TLS/鉴权/单行写入证据、真实helper回复、权限、公开资料SHA与扫描。准备阶段20个公开证据文件按新MCP token和两把私钥7种字节形式扫描，0命中，三个真实秘密文件明确排除。`/tmp/ruukoto39-mcp-config-preflight.log`另记录应用层严格发现通过；没有声称真实模型/MCP审批或完整A7通过。
