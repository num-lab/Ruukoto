# Linux最终日志与A6归档补充取证

通过task-owned ControlPath=/tmp/ruukoto39-ssh-control.sock取回指定五份原日志；本地SHA256逐项等于远端读取值，未改根仓库、collector或运行服务，没有模型或服务动作。summary.json逐项保存指纹、计数与范围。

| 原日志 | 最终通过 | 失败/取消/跳过 | 总耗时 |
| --- | --- | --- | --- |
| ruukoto39-final-durable-ready22.log | 27/27 | 0/0/0 | 12.006秒 |
| ruukoto39-final-durable-ready24.log | 27/27 | 0/0/0 | 9.197秒 |
| ruukoto39-final-personal22.log | 114/114 | 0/0/0 | 90.418秒 |
| ruukoto39-final-personal24.log | 114/114 | 0/0/0 | 82.813秒 |

114项两轮使用browser报告两行修复前的源码，因此不覆盖那项后续delta；27项两轮位于ready最终cleanup之后，覆盖fixture前after等待子进程close与launch取消守卫。此源码时序依据根交接绑定；日志自身未嵌入源码指纹，不能仅凭日志反推全部源码。不同范围与重复平台轮次不拼成一次最终全仓通过。

build日志保存npm run build及两产品npm pack输出，末尾为ruukoto-code-0.1.0.tgz；它没有测试计数或显式exit标记，仅凭此日志不额外补写进程exit0。原调度进程的退出状态由根原执行材料持有。

A6 evidence.tar.gz（SHA256 5a6c4bca0dab8c378ef0635430640b69d2976b702d6d2f3bd2c296c52e82970d）按四份本地私有凭据原值作补扫：4个不同值、72种去重变体，覆盖原文、JSON/Unicode转义、URL/plus/二次编码及百分号大小写、base64/base64url/MIME及常见Bearer/Basic前缀编码、hex大小写。归档26文件成员及5份本地附属JSON/Markdown中匹配均0。没有输出或归档凭据值、前缀、长度或其指纹；扫描事实在a6-four-credential-scan.json，扫描脚本另位于/tmp/ruukoto39-a6-four-credential-scan.py。

collector元数据只查存在性与SHA：/tmp/ruukoto39-final-artifacts.py存在，SHA256 810b0c174090790a9852a4db86d29838e21a08f358e4c5c1642a94ac80c0f0c4；其结果/tmp/ruukoto39-oracle-artifacts.json存在、13545字节，SHA256 9900b7cff5a6f19900dc98280699ef05d812905a6b4a628d1d8a42a9ea111269。未执行collector，也未读取或更改运行服务，见collector-metadata.json。

可直接归档本目录五份.log、summary.json、collector-metadata.json与a6-four-credential-scan.json；README.md说明适用范围。不复制任何credentials目录。
