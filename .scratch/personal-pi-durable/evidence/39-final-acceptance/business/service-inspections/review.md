# 真实固定service_inspect原执行结束核查

2026-10-18只读核查结论：本轮组合已有两项真正模型`service_inspect`的正常结束证据，且各自原helper启动器PID/启动时刻/进程组和持久`stop-inspect exited=true`可对齐。它们不是service_restart的stop-op，不需要为了证明“正常原检查已经结束”再造新检查。它们没有经历中断、取消或迟到启动，不能冒充未知/迟到窗口验证。

没有调用helper、检查、restart、模型或IM；没有开第二Harness。只复制已保存私有SQLite/WAL/SHM到本次0700目录，在副本readOnly读取并重建documents；通过原ControlPath读取远端三个精确claim和/proc身份，另做两次认证GET /inspections。令牌仅内存读取，未输出。

## 原ID与证据链

| 业务 | 原生身份 | 持久接纳/结果/停止 | 实际模型历史 |
| --- | --- | --- | --- |
| 重启前子检查 | document390，task389，conversation340，generation385；`inspect_bd23abba31f078ed1958ada8` | admission391、inspect结果392、stop-inspect393；doc.stopped=true，task completed | assistant388发service_inspect；原工具结果394；后续read_service_inspection的工具历史400读取该证据 |
| 重启后的子检查 | document427，task426，conversation340，generation422；`inspect_e816bcd0dbeb4b8a887f9017` | admission428、inspect结果429、stop-inspect430；doc.stopped=true，task completed | assistant425发service_inspect；原工具结果431；后续read_service_inspection的工具历史437读取该证据 |
| 服务操作内的预检查（单独列出，不冒充模型固定检查） | document409，service-operation task407；`inspect_0cf781bd2fea0946e31ad959` | admission410、inspect结果411、stop-inspect412；同样已停止 | 由服务操作内部准备调用，不是另一条service_inspect模型调用 |

两个模型检查均归原source Submission332、work346/长期子会话340，permission为原full_access/version4，工作输入350；接纳data与document身份逐对象相等。原结果code=ok/truncated=false，stderr中的原字节`RUUKOTO_SERVICE_REPLY`各唯一、与document保存reply逐对象相等；stop记录的原始stderr和结构reply亦逐对象相等，inspectionId、machineId、verb、exited全部相符。

## 真实OS对齐

远端保存的claim均为root拥有、0600、nlink1、非符号链接，claimedBy=inspect-op，机器身份与当前/etc/machine-id一致。两项模型检查的launcher分别为：

- `inspect_bd23...`：PID3459327，startTime409454921，processGroup3459326；stop-requested时间2026-10-18T13:59:41.670Z。
- `inspect_e816...`：PID3459458，startTime409455493，processGroup3459457；stop-requested时间2026-10-18T13:59:47.390Z。

当前仍为原boot；两个原PID均不存在、相应进程组成员均为空。操作内预检查的原PID3459371/group3459370也同样结束。历史stop-inspect回执已将“原PID不再匹配且原组不存在”核实为exited=true，当前独立/proc观察与其一致。`/inspections`认证GET返回200、items=[]；私有一致快照pending.tasks也为空。

helper现有SHA256 `3f645f2ef05ff626f1def39ef1b0065f893385f96bdb0142c14aad864fb6433f`，与仓库原字节helper及准备记录一致；policy现有SHA256与历史inspect reply的policyRevision均为`83cbea028f2c5954d6ffe06d559a8c8862fa65e5bae02700743b3f5854c654da`。历史inspect stdout是实际systemctl字段，两个模型检查分别观察到重启前后不同MainPID/InvocationID。此证据可归真实helper/systemctl正常检查，不归旧helper替身。

## 最小尚缺与范围

正常固定检查停止事实已足够，可从此前待验描述中分出关闭。原规格A3“真实进程停止核实”的正常叶覆盖可复用，不必为同样事实再运行检查。

39另承接的“后台中断后原检查仍活着、停止未核实继续占用、原菜单/本机重核后收齐、迟到结果不复活”仍不能由这两次正常检查证明。本快照没有检查在途时的SIGKILL/取消、未核实阶段、迟到原调用或原control决定。只有若39仍要求这一异常链，才需要Agent在新隔离档案绑定一个真实原检查身份做单个中断窗口；无需新restart或真人重复核实菜单，不能以旧19/20 helper替身当真实OS。当前核查没有执行该额外窗口。

## 材料

- `source-copy.json`：既有私有一致快照的来源及复制哈希；本目录副本仅为只读核查，原raw包已由根保存，不建议重复归档整库。
- `read-db.mjs`、`db-readonly.json`、`db-readonly-verified-summary.json`：原Task/Doc/Entry链、原始reply深相等与pending断言。
- `read-remote.py`、`remote-readonly-verified.json`：精确claim身份、原组/proc独立观察、helper/policy摘要、GET结果；脚本未执行任何helper。
- `remote-readonly.json`是首轮只读采样，GET envelope的result尚未解包所以pendingItems为null；后续verified文件正确解析{v,ok,result}且为[]，首轮原件保留，null不当作空列表。

本报告不扩散原IM正文、model凭据或control token。主报告与上述JSON均只含测试服务和执行身份事实。
