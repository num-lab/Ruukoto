# 居中加载页与 Desktop 同步验收

2026-10-18，macOS arm64 / Node 24.15.0。范围为[迁移工单](../../issues/28-startup-loading-migration.md)，源文件固定在 sources.sha256；保留既有未提交改动，本轮不提交或重启日常进程。

## 工程验收

Demo npm run check、根 npm run check:static 均退出0。test/38-desktop-main、38-desktop-personal、38-desktop-build、43-desktop-demo、desktop-composer 共102项通过、零跳过。Electron desktop:build 与 MyGo desktop:mygo:build 均退出0，两份 app 的 codesign --verify --deep --strict 通过。保留构建工具原有的 bundle 大小、Electron 默认图标及打包提醒，未新增依赖。

startup_loading_review 独立实现审查无阻断，亲自运行 test/43 与 desktop-demo-v4 共5项、git diff --check 通过，核对实际截图、指标和共享组件逐字同步。其浏览器 inventory 不可用，交互由主代理执行，不记为独立浏览器复验。

## 浏览器验收

[夹具启动器](browser-fixture.mts)使用实际 Desktop App、CodeState、ConnectionLoading 和全部样式，bridge 仅提供隔离状态；不使用真实后台或 PA 网络。用 npx tsx 运行启动器后打开输出的本地地址，case 支持 slow、sync、online-before-snapshot、failed、retry、closed；后两种在线场景以8秒定时器模拟快照到达。夹具按钮「模拟普通断线」在加载结束后可重试普通断线路径。

真实 IAB 的 browser-metrics.json 记录：Desktop 状态行中心为639.996×360，视口中心为640×360；Demo 单行同样中心误差小于1px，隐藏标题宽1px，无可见 Ruukoto。截图分别为 desktop-loading.png 与 demo-centered.png。Demo 刷新和设置重播均显示遮罩、隔离底层并保持焦点，2.2秒模拟后恢复。

sync 在 subscribe 内同步发送快照与 online，最终遮罩不存在、inert解除，设置能打开且可聚焦；failed、retry、closed 均撤下遮罩，保留错误或状态详情和重新连接。随后手动重新连接与普通断线不重新弹遮罩。PA 未配置时可进入其连接表单。

online-before-snapshot 先报告 online 但没有实例快照，在6095ms时仍显示遮罩且保持 inert，证明正式端未采用 Demo 的2.2秒退出；8秒夹具快照到达后解除遮罩并聚焦侧栏按钮。初次尝试等待短暂 closed 动画时，浏览器工具单次等待期限先到，已改用持续状态与最终状态断言，没有把等待超时记成产品通过。浏览器无 error／warn 日志。

## 未覆盖项

未启动日常 MyGo／Electron 或重启真实后台；真实首次冷启动耗时、PA 外网连接、系统减少动态效果及减少透明度偏好未实测。构建包含实际展示代码，日常应用重启后采用；本轮没有改变后台连接或重试策略。
