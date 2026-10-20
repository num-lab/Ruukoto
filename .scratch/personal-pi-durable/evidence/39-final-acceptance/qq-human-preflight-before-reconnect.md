# QQ 真人控制前只读预检 v3

结论：**暂不可请求本人发送第一条QQ委托**。正式后台在线且空闲，服务/权限/绑定前提均符合最小方案；但当前 `/qq` 返回 `online=false`。本探针未尝试重连、建WS或发送消息，交根现有连接诊断处理。

时间：2026-10-18T16:30:04.869Z 至 2026-10-18T16:30:04.924Z。主机 oracle-4c24g，使用既有 SSH ControlPath `/tmp/ruukoto39-ssh-control.sock`；正式Node `/home/ubuntu/.local/ruukoto39/node-v24.15.0-linux-arm64/bin/node`，版本v24.15.0。

| 检查 | 实际结果 |
| --- | --- |
| 后台 `/status` 前后 | tasks=0、inputs=0，services=true |
| QQ连接 `/qq` | enabled=true、receiving=true、online=false |
| `/permissions` | default=auto-review、QQ=auto-review；未修改 |
| `/service/grants` | 穷尽分页，count=0 |
| `/services`、`/inspections` | 原服务记录1条，无未核实操作；pending检查0；与后台无活动Task相符 |
| 精确测试服务 | ruukoto39-test.service，loaded、active/running，Restart=no，NRestarts=0 |
| 原效果未增加 | count=3；MainPID/InvocationID均与新异常检查前原环境一致 |
| 原helper | SHA256 `3f645f2ef05ff626f1def39ef1b0065f893385f96bdb0142c14aad864fb6433f`，与原字节相同 |
| 原policy | SHA256 `83cbea028f2c5954d6ffe06d559a8c8862fa65e5bae02700743b3f5854c654da`，与原字节相同；仅允许ruukoto39-test.service的restart |
| QQ原绑定 | enabled、generation、账号、endpoint、凭据digest、完整配置与原证据匹配均true；账号/代次/凭据值不输出 |

`/services`依据其宿主投影的canResolve/canRecheck/待执行/停止未核实状态核对，并与 `/inspections` 和两次 `/status` 交叉；没有打开第二Harness或直接写SQLite。辅助计数不单独证明服务效果，MainPID/InvocationID相同支持本次没有重启。

只调用既有控制GET：/status, /permissions, /service/grants, /services, /inspections, /qq；精确systemctl show、既有count文件和helper/policy/config只读。不调用helper、不做service写、不POST、不建Harness、不建WS、不调用模型或IM、不改模式。

原响应仅在远端 `/tmp/ruukoto39-qq-human-preflight-private-42XB9S`，目录0700，3个文件均0600；包含私有收件/配置，只留临时、不归档。脱敏JSON为 `/tmp/ruukoto39-qq-human-preflight-v3.json`。根可归档这两份脱敏文件；本报告不把QQ离线记成完成或图片恢复。
