# 生产加载页偏移回归

2026-10-18，恢复[加载页迁移](../../issues/28-startup-loading-migration.md)约定的全屏居中。本轮仅改三处同步 CSS 的 translate 重置、添加窄构建回归并补足生产与原生证据，不改连接状态或后台。上一轮开发服务器截图对生产定位的结论失效，原连接状态证据继续成立。

## 复现与根因

npx tsx --test --test-name-pattern='加载页的独立位移' test/38-desktop-build.test.ts 在修复前退出1：实际样式经 Safari 16 目标压缩后只剩 transform:translate(0,0)，没有独立 translate 重置。Dialog 默认的 translate:-50% -50%仍生效；相同问题也存在于 Demo 和 Electron 生产 CSS。

[probe.mts](probe.mts)加载实际 Desktop App 与已经构建的 MyGo CSS，不经开发 CSS 转换。浏览器实际测量为 X=-640、Y=-360、宽1280、高720，视口1280×720，见 red-position.json 和 before.png。原生隐藏 WKWebView 用相同页面得到相同位移，native-red.json 中内容中心落在0×0；探针退出1。探针不连接后台、不创建用户资料、不操作日常应用。

## 修复与验证

三处样式统一使用 transform:none 与 translate:initial。translate 不继承，initial 的计算值是 none，生产压缩保留该独立属性；其余样式和状态不变。构建回归直接读取实际差量 CSS 并压缩，现有 test/43 核对差量与 Demo／Desktop 同步。

test/38-desktop-build 与 test/43-desktop-demo 共9项通过，Demo check 和根 check:static 通过。loading_build_audit 独立审查无阻断，亲验窄构建回归及 test/43 共3项，核对当前 MyGo 产物保留 transform:none;translate:initial、红绿矩形、源码与截图。MyGo 与 Electron 重新构建，签名检查通过。

修复后浏览器 green-position.json 的 X/Y=0，中心639.996×360；原生 native-green.json 的 X/Y=0、宽高等于视口、中心640×360，计算后 translate 与 transform 均为 none，探针退出0。浏览器截图为 after.png；原生验证为实际隐藏 WKWebView 的布局测量，不把浏览器截图称为原生截图。

## 复查入口

从仓库根运行 npx tsx .scratch/desktop-shadcn/evidence/loading-position/probe.mts，启动生产 CSS 页面。原生探针源码为 native-probe.go；在 apps/desktop/mygo 目录用 go build 指定该文件生成临时二进制，运行时设置绝对路径 RUUKOTO_LOADING_QA_OUTPUT。探针自行退出，用0／1表示布局通过／失败，最长等待10秒；它读取实际生产 CSS，因此先运行 desktop:mygo:build。

源文件哈希在 sources.sha256。验证结束已关闭隔离页面和服务；未重启拥有者的日常应用或后台，未提交或推送，未重跑全仓与平台矩阵。
