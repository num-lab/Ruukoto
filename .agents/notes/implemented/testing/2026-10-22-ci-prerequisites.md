# Agent Note: CI 显式准备系统前提

Status: implemented

## 问题

[最新 CI](https://github.com/num-lab/Ruukoto/actions/runs/39720984008) 四格在 setup 因缺 rg 退出。[前一轮](https://github.com/num-lab/Ruukoto/actions/runs/39457723330) 的 Linux 真实工作流另报缺 bubblewrap 或 user systemd，文件树回归在 Vite SSR 导入 xterm 的 CommonJS 命名导出时退出，尚未执行全部 UI 断言。

## 决定

GitHub Actions 在 setup 前用系统包管理器安装 ripgrep；Linux 同时安装 bubblewrap、AppArmor 和 user bus，复用仓库的 bwrap profile 与 user manager 配置。设置当前及后续步骤的 runtime dir 和 bus 地址，先核实完整 namespace 与 Delegate=yes 的 user scope，再执行原 setup / check。setup 仍只检查系统前提，不替开发者安装软件。保留按路径 userns 授权与原有用例，不放宽整机限制。

文件树 SSR 回归将 xterm 与 fit addon 列入 Vite 的 noExternal，使其按包声明使用 ESM 入口，并补齐 Inspector 新增的 terminalTabs 空列表夹具；生产 renderer 的加载与终端逻辑不变。保留原文件树、错误反馈和新标签页断言，不增加重复测试。

全量回归的旧夹具沿现行契约同步：等待视图不固定历史协议版本数值；Plan 白名单列出已开放的提问与后台观察工具；桌面创建只模拟应答丢失，其余请求接真实临时后台。TUI demo 继续覆盖全部事件类型，并让会话后台、拥有者问题的快照、查询与事件共用静态终态样例，写操作继续拒绝。保留业务断言，不通过减少事件覆盖或放宽工具集合取得通过。

项目中途禁用 Web Search 时，测试核实发送白名单已中断后续请求，不要求抵达工具内部的旧错误文案。GitHub webhook 的同进程客户端使用十秒等待预算：独立时序探针中服务端约 17ms 已结束响应，后续同步派发却令客户端两秒计时先于读响应执行；“不等待评审”继续由 HTTP 返回时模型门尚未释放证明。

模型配置回滚按 RuntimeApiError 与 model_config_invalid 核实，保留原字节回滚及不泄露内部错误的断言。工作副本停止夹具等待目标单元前包含真实委派、子任务与汇总准备，默认十五秒在本机窄测也会耗尽；该处等待改为六十秒，仍以目标单元的实际出现为条件，不延长产品时限或减少停止断言。

macOS 持久执行夹具追加 TERM 标记并核实至少一次信号。监督器在 TERM 阶段会重发信号，截断重写可能在最后一次写入被 KILL 打断时擦掉已有证据；本轮观察到停止成功但标记为空，未采集具体系统调用时序。停止成功、双管道 EOF、错误指纹不停止与原执行不重放的断言保持。

应用测试的非独占批次固定最多两个文件并行，macOS 既有独占批次仍为一个。十核本机默认并行时，多份真实 worker 夹具竞争使若干十五至六十秒等待耗尽，定向复跑通过；限制文件层并行，保留单用例内三个 Agent 的并发验收。代价是更多核心不再提高文件并行数；本机全量已接近原三十分钟上限，GitHub job 时限改为四十五分钟以容纳环境准备，四格实际耗时仍待核实。此项取代[联合验收](2026-10-13-workflow-joint-acceptance.md)的默认文件并行安排，不改分批成员、产品预算、失败透传或离线开关。

## 既有决定

[测试精简](../testing/2026-10-24-test-suite-reduction.md)逐项裁剪退役和重复成员，部分取代本篇保留全部成员的范围；系统前提、失败透传、并发与独占规则继续适用。

[受控检索](../feature/2026-10-21-controlled-file-search.md)持有 rg 前提和禁止调用时下载；[原生执行](../architecture/2026-10-10-native-execution-sandbox.md)持有 AppArmor、user scope 与停止核实；[文件树反馈](../feature/2026-10-17-desktop-file-tree-loading.md)持有回归行为。本篇补充 CI 装配、测试加载、现行契约的夹具同步与文件并行限制，保留这些产品决定。按 CI、setup、rg、bubblewrap、SSR 与文件树检索，其他命中为无关产品行为，无过时提案。

## 备选方案

- 去掉环境检查或跳过原生用例：恢复检查入口最快，但缺失的真实执行能力会被隐去，不能证明现有产品要求。
- 在 setup 自动安装系统依赖：开发机与 CI 可共用入口，但会引入提权与系统策略修改；保留开发机显式安装，仅在临时 runner 装配。
- 修改终端生产 import 或模拟整个终端组件：可以绕开 SSR 导入失败，但问题在测试加载入口，已有 Vite 配置能使用真实包的 ESM，影响更小。

## 后果

CI 安装增加系统包下载和 user manager 的前提；平台镜像变化仍可能令准备步骤失败，失败直接暴露，不重试或跳过。SSR 用例继续加载真实右栏，但不证明真实终端渲染。正负例、平台环境与未验证项由[修复工单](../../../../.scratch/ci/issues/01-restore-ci-prerequisites.md)记录，本地通过不代替 GitHub 四格结果。
