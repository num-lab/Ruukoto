# 后台进程改动前的实际 SDK 快照

2026-10-21，独立 detached HEAD 检出 `01e9e74457a58473b9df1bbdb876cfc9c207747d`，目录 `/tmp/ruukoto-background-token-before-20261021`；独立安装依赖，workspace 包软链均指向该旧检出。运行后 `git status --short` 为空，主工作区未写。

普通拥有者新 Coding 会话、full_access、非 Plan、默认真实工具工厂、无 MCP/项目指令/技能定制；与改后 DeepSeek 验收固定同一实际工作目录，避免 cwd 字符数造成系统提示估算差异。模型使用离线 MockModelServer，只返回文本；真实 SDK stream 路径发起一次请求并保存 prompt 快照，0次工具调用，未启动 macOS 监督器、浏览器或业务服务。估算取真实选择记录，不手算或过滤工具伪造旧版本。

| 阶段 | toolSchemas | systemPrompt |
| --- | ---: | ---: |
| 改前旧提交首轮完整工具 | 11747 | 1505 |
| 改后实际 DeepSeek 首轮完整工具（主线另存证据） | 12944 | 1505 |
| 改动差值 | +1197 | 0 |

改前共32个工具。改后后台观测阶段2027/1505是运行时收窄结果，不作为改前数字。

文件：`capture.mts` 是实际运行脚本；`result.json` 含条件、工具名单、估算与快照SHA-256；`selection-record.json` 是原选择记录；`prompt-snapshot.json` 是SDK发送函数前捕获的完整systemPrompt/messages/tools。快照不等同于提供方适配后的HTTP请求体。模型为mock/mock-model，计数方法由同一选择器持有；未声称本次基线请求使用真实DeepSeek。

复现（已有独立检出时）：

```sh
cd /tmp/ruukoto-background-token-before-20261021
npm install --ignore-scripts --no-audit --no-fund
node --import tsx /tmp/ruukoto-background-token-before-evidence/capture.mts /tmp/ruukoto-background-token-before-20261021 /tmp/ruukoto-background-token-before-evidence /private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-background-model-iSDCD2/work
```

工作目录须仍存在；若更换路径，toolSchemas仍可比较，但systemPrompt可能因路径字符数改变，应记录新条件。本脚本使用新隔离数据档案；只读取给定工作目录，不在其中执行工具。单次结果：providerCalls=1、toolCalls=0，toolSchemas=11747、systemPrompt=1505，prompt SHA-256=`1b3dca7e599ee395c62722269d9e8d866cf16611cbdf71dd797ac91521edc7ab`。

入库副本仅补文件末尾单换行；本篇与result.json中的prompt SHA-256对原始无末尾换行字节计算。
