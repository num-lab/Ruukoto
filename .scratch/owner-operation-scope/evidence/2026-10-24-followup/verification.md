# 第 4、5、6 项验证记录

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

基点为 `171cc0b1`，前三项在本轮开始时已提交且提交钩子通过。本记录覆盖其后未提交的硬链接预览、技能读取复用及原生显式挂载批量核对。已有 CI／测试策略工作不在范围内；最终受验内容见 `source-hashes.json`。

## 文件预览

修改前运行 `npx tsx --test --test-name-pattern='硬链接|拥有者控制面' test/desktop-workspace-files.test.ts`，三个用例均因旧硬链接拒绝失败。修改后 `npx tsx --test test/desktop-workspace-files.test.ts test/desktop-live-files.test.ts` 共 42 项通过。覆盖普通硬链接完整分页、另一名字修改后拒绝旧修订、读中变动丢弃，以及真实 Runtime/control socket 读取；原目录替换、符号链接、错误分类与 renderer 分页回归保持。

## 技能

独立工作副本运行 `npx tsx --test test/56-skills.test.ts test/managed-skills.test.ts test/managed-skills-reference.test.ts test/personal-skills.test.ts test/personal-managed-skills.test.ts test/desktop-settings-skills.test.ts`，82 项全部通过，见 `skills/skills-green.log`。旧实现三个定向回归全部失败，见 `skills/skills-red.log`；五个修改文件的受验哈希与汇总源码一致。

真实 `openPersonalHarness` 及本机 HTTP 模型替身覆盖：准备后外部正文变化，本次规范输入、实际 payload 及持久记录均保留旧正文，下一请求读取新正文；单请求每个正文两次读取，分别为 SDK 元数据解析和宿主钉版，两个发送边界不再读正文。管理 list/get 对外部正文从四次读降至两次，对托管引用文件从四次包读取降至一次。未新增跨请求缓存。

在规范输入与实际 payload 边界分别停用、移除所选托管技能，四个组合均为零 HTTP 外发；前者不写请求证据，后者只保留规范输入证据。配置或目录身份变化、清单缺失／损坏／权限不符、选择修订变化继续拒绝。旧快照、显式展开和重开恢复仍按原格式核实。

## 原生受限执行

见 [native/verification.md](native/verification.md)。三个显式挂载的保护树扫描从四次降至两次，分别用于显式挂载和运行依赖；原代码在枚举计数回归失败。macOS 和 Linux 各 12 项入口／批量回归通过，macOS 原有输入用例另有 5 项通过。

两个平台直接使用正式原生启动器核实 confirm／auto-review 的工作区及授予读写、只读根拒绝写入、保护目录不可读和停止完成。Linux 在真实 bwrap namespace 内核实目录 bind 作为工作区／末项授予、nlink=1 文件 bind 作为末项只读根均被拒绝，退出 namespace 后原路径可通过。Linux 受验的十个源码／测试文件与主工作树 SHA-256 一致；只用任务临时目录，无系统安装变更，远端资源已清理。

## 汇总与独立审查

汇总后的定向回归共 22 项通过，命令选择文件硬链接、native 批量、技能读取次数及实际双发送边界，输出见 `integrated.log`。集成只复制已核实的完整源码／测试文件，未产生额外实现差异。

主工作树 `npm run check:static` 全部通过，覆盖 lint、全部 workspace／foundation 类型、notes 与 docs 门禁，完整输出见 `static.log`。`git diff --check` 通过；日志仅整理行尾和末尾换行。

独立代理 `read_overhead_review` 对三项方案、最终代码及文档审查无阻断，亲跑文件／批量 16 项、native 12 项、技能 60 项均通过，另构造七条技能反例确认缺包、读中修改、后续篡改及选择身份异常拒绝。审查者直接阅读两平台原生执行与 Linux bind 的断言脚本、日志和源码哈希，未亲自重跑远端 Linux。

## 未验证及限制

未跑全量 `npm run check`、真实模型、IM 或原生 Desktop 产品端到端；模型验证为真实宿主链路加本机 HTTP 替身。日常服务未重启，本轮新改动未提交。多包文件系统读取仍不是原子快照；每次单包读取的稳定性核实保留，外部技能修改按下次请求准备生效。目录分页与 Git 预取不在本轮范围。
